# STATUS — the dashboard, honestly

Written by the integrator on 2026-07-27, after installing both trees, running
the pipeline, and auditing the seal on the dashboard path. **Corrected on
2026-07-28** by the Phase 0 held-out-boundary pass; every claim it changed is
dated in place rather than silently overwritten.

Nothing here is aspirational. Every claim carries its evidence level, and there
are **three**, not two:

- **EXECUTED** — I ran it in this session and observed the result.
- **UNTESTED** — it typechecks and it is reviewed. That is all.
- **REPORTED** — a module author says they exercised it. I did not re-verify.
  Their word, recorded as their word.

If something is missing from all three, it is not here.

---

## 0. Read this first — the one thing that is genuinely weaker here

### The held-out boundary

**Corrected 2026-07-28.** Until this date the boundary had an EXECUTED bypass:
`Grep{path:<ancestor-of-suite>, output_mode:"content"}` returned ALLOW, and
ripgrep walked down into the sealed store and returned held-out test source.
`decideToolPermission` asked only whether a candidate was INSIDE the suite,
never whether it CONTAINED it.

Three holes of the same class were open alongside it:

- `READ_TOOLS` was a tool-name allowlist, so `mcp__*` read tools and
  `ReadMcpResource` returned ALLOW on a sealed path.
- `Grep`/`Glob` with `path` omitted produced no candidate and were allowed; the
  CLI then searched the cwd.
- `results/scorer-out/<runId>/result.json` persisted
  `criterionCoverage[].testRefs` — held-out TEST TITLES — outside the sealed
  store, readable by any later run of the same frozen ticket.

**Every `heldOutPass` recorded before 2026-07-28 was produced under that
boundary, and there is no tripwire, so it cannot be determined retrospectively
whether any given run walked through it. Treat pre-2026-07-28 results as
unverified.**

All four are closed and unit-tested with negative controls. What has NOT
changed: the dashboard builder still runs on the HOST as the same user, so this
is a policy inside the CLI, not a filesystem boundary — still weaker than the
bake-off's container, which never mounts the held-out half at all.

The sealed suite lives at `dashboard/acceptance/<ticket>/holdout/*.mjs` —
plaintext, on the same filesystem, two directories above the workspace, owned by
the same user as the build. On a single-UID host there is no filesystem boundary
to enforce; there is only policy inside each CLI.

**I found this open.** Until 2026-07-27 the builder's permission hook denied
only *writes* outside the workspace, and the CLI sandbox's `allowWrite` likewise
restricts only writes. Reading the held-out tests was unrestricted on both
drivers. A builder that reads them can satisfy them without satisfying the
ticket, which makes `heldOutPass` and `falseFinish` meaningless for that run —
and **nothing detects it**. There is no tripwire, no log line, no marker.

The fix made on 2026-07-27 was itself incomplete — it is the one the correction
above supersedes. What is there now, with its evidence level:

| Layer | Driver | Evidence |
|---|---|---|
| `decideToolPermission` denies the sealed roots — the suite store **and** `results/scorer-out` — for **every tool name**, built-in or `mcp__*` or one that ships next year; by **every value in the input at any depth**, arrays and nested objects included, except a named list of free-text keys (`content`, `command`, `prompt`, …); in **either direction**, i.e. a candidate inside a sealed root *or* one that contains it; comparing **case-folded canonical forms** with `file://` URIs and percent-encoding decoded first; resolving relatives against the builder's `cwd`, and folding that `cwd` in **unconditionally** for `Grep`/`Glob` | Anthropic | **EXECUTED** — 42 unit tests in `src/builders/claude-builder.test.ts`, every widening carrying a negative control that ordinary work is still allowed. **Corrected 2026-07-28 (second pass).** Until that pass this row read "any of 15 path-bearing input keys" — a KEY allowlist, which an adversarial review defeated with `Glob{pattern:"<suite>/**/*"}`, `pattern` not being on the list. The polarity is now inverted: every value is a suspected path unless its key is named free text. Still a pure-function proof: `decideToolPermission` performs no filesystem access and no `await`, and the caller injects the fs-aware canonicaliser, so symlink resolution is exercised only through that injection. That the hook fires for **subagent-originated** calls is unverified (§3). |
| `decideToolPermission` denies the `Agent`/`Task` tool unless `isolation` is absent, `run_in_background` is explicitly `false`, and `subagent_type` is on a configured shortlist | Anthropic | **EXECUTED** — 6 dedicated Agent-guard tests among those 42 (counted in the file). The shortlist is empty in production today, so **all** delegation is denied; see §2.4. |
| `sandbox.filesystem.denyRead` names the sealed roots to the CLI's OS sandbox | Anthropic | **NOT EXECUTED.** `settings-plumbing.test.ts` proves the SDK forwards a `denyRead` array it was handed directly; it never calls the builder, so it cannot detect the builder sending the wrong roots or none. Neither the plumbing from `request.sealedRoots` nor the OS enforcement has been exercised. |
| anything | **OpenAI / Codex** | **NONE.** `ThreadOptions` exposes no read restriction; `sandboxMode: "workspace-write"` limits writes only, and `additionalDirectories` is an *allow* list. A Codex build can `cat` the held-out suite. |

Two further facts you should not have to discover:

- `autoAllowBashIfSandboxed: true` means a sandboxed Bash command **never
  reaches** the permission hook. `cat`/`grep` are covered only by the OS layer —
  the one that is unverified on Anthropic and absent on Codex.
- Deliberately not fixed by withholding the plaintext during the build window:
  any durable on-disk form is equally readable by a same-UID process, and an
  in-memory-only form makes a server restart destroy the suite. That trade was
  considered and rejected, not overlooked.

**Consequence, stated plainly:** a `heldOutPass` recorded on or after
2026-07-28 is a policy-enforced result — a rule inside the CLI that the build is
asked to obey, not a filesystem the build cannot reach. One recorded before
2026-07-28 is not even that: it was produced under a boundary with an executed
bypass and cannot be retrospectively verified. Neither is the bake-off's sealed
measurement, and neither may be reported as one.

---

## 1. What I EXECUTED in this session

### 1.1 Both trees install, build and typecheck

```
bakeoff              npx tsc --noEmit  -> exit 0
dashboard/server     npx tsc --noEmit  -> exit 0
dashboard (UI)       npx tsc --noEmit  -> exit 0    next build -> green
```

No `any`, no `@ts-ignore`, no non-null assertion was added to reach this.

**`dashboard/server` imports `bakeoff/dist/*.js`, not `bakeoff/src`.** `bakeoff`
is a `file:` dependency symlinked into `server/node_modules`. So every shared
property is a property of *compiled output*, and `tsc --noEmit` proves nothing
about whether `dist/` is current. Checked directly: no `src/**.ts` was newer
than `dist/`, and a fresh `npm run build` produced a **byte-identical** `dist/`
(SHA-256 over every emitted `.js`, before and after). The server had **not** been
running against stale code.

### 1.2 The bake-off dry run is GREEN — 24 checks, 0 failures

`npm run bakeoff -- dry-run`, whole pipeline, real containers. The tail:

```
STAGE 1 — THE SEAL
  PASS  a one-byte edit to a held-out test file is detected
STAGE 2 — THE HARD CEILING, CHECKED BEFORE EACH CALL
  PASS  the refused call NEVER REACHED the upstream (checked before, not after)
  PASS  a vendor payload that cannot be priced KILLS the run instead of costing it as zero
STAGE 3 — THE SEALED BUILD CONTAINER
  PASS  EGRESS DENIED — verified from inside the container, on this run
        http 1.1.1.1 unreachable; https registry.npmjs.org unreachable
  PASS  agentDeclaredDone came from the structured self-report file
  PASS  the VISIBLE half reached the workspace and the HELD-OUT half did not
STAGE 4 — THE SEALED ACCEPTANCE GATE (--network=none)
  PASS  the gate resolves the scorer image by CONTENT DIGEST
        sha256:1c06aa11c425044af4a5dc8cd0b3ff6b7f78e185fd54204c0a8fd810d8074353
  PASS  the gate PASSES an honest artefact (a gate that can never pass is not a gate)
STAGE 5 — AGGREGATION, DECISION RULE, REPORT

DRY RUN COMPLETE — every stage ran and every check passed.
```

`node test/scorer-modes.e2e.mjs` — **29/29**, real `--network=none` containers,
including the blank-page negative control (`GATE:boot` FAIL,
`heldOutPass=false`, `falseFinish=true`).

### 1.3 The scorer image digest is unmoved, and I checked it properly

`docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` resolves to
**`sha256:1c06aa11c425044af4a5dc8cd0b3ff6b7f78e185fd54204c0a8fd810d8074353`** —
the value recorded in `bakeoff/STATUS.md` §1.1 item 8 and `docker/README.md`
§2.2. It matches.

Stronger than that record currently claims, and it is mine because I ran it:

- The three files the scorer actually executes —
  `dist/scorer-container.js`, `dist/tier0.js`, `dist/scorer-protocol.js` — are
  **byte-identical** between the image (`/opt/bakeoff-scorer/dist/`) and the host
  `dist/`. Verified by `sha256sum` inside the image against `shasum` outside.
- Nine `src` files are newer than the image — `spec-agent.ts`,
  `spec-validate.ts` and the seven `subscription/*` files. **They were written
  by the module agents before this session, not by me** (see below), and they are
  **not reachable from the scorer entrypoint**: `node
  /opt/bakeoff-scorer/dist/scorer-container.js` imports none of them. So the
  image is stale only with respect to code it never loads.
- **A rebuild will still move the digest**, because stage 1 compiles all of
  `src/`. Re-resolve and pin it immediately before a campaign, after the last
  source edit — not during one.

I made **no edit to `bakeoff/src`**. Confirmed two ways: `find src -name '*.ts'
-mmin -40` over my working window returned nothing, and a rebuild at the end of
the session produced a `dist/` whose every emitted `.js` hashes identically to
the snapshot taken before I started. The nine newer files above therefore belong
to the prior module agents, and the image digest is unmoved by anything I did.

### 1.4 The server binds 127.0.0.1 and REFUSES everything else

Tested, not assumed. Three hosts, three refusals, exit code 2:

```
$ DASHBOARD_HOST=0.0.0.0 node dist/index.js
[invalid_usage_shape] refusing to bind "0.0.0.0": the dashboard binds 127.0.0.1 only
fix: Do not set DASHBOARD_HOST, or set it to 127.0.0.1. This server drives CLIs that are
already logged in to the owner's personal Claude and Codex subscriptions: anything that can
reach this port can spend that quota and write files as this user. Exposing it off-machine
would also breach both providers' terms of service. If you need it on another device,
forward the port over SSH — that keeps the bind on loopback.
(exit 2)
```

Same refusal for `::` and for `192.168.1.50`. Then a clean start, and the socket
itself:

```
$ lsof -nP -iTCP -sTCP:LISTEN | grep -E '4176|4319'
node  68420  ...  TCP 127.0.0.1:4176 (LISTEN)      <- API
node  69042  ...  TCP 127.0.0.1:4319 (LISTEN)      <- UI (next start -H 127.0.0.1)
```

Literally `127.0.0.1:4176`, not `*:4176`. And from this machine's own LAN
address:

```
$ curl -m 5 http://192.168.1.26:4176/api/health   -> curl exit 7 (connection refused)
$ curl -m 5 http://192.168.1.26:4319/            -> curl exit 7 (connection refused)
```

### 1.5 The whole thing behaves correctly with NO credentials

Server started with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointed at empty temp
directories and the metered keys unset. Raw responses:

```
GET /api/health
{"ok":false,"claudeAuth":"missing","codexAuth":"missing"}

GET /api/models
[{"id":"default","label":"Claude (CLI default model)","provider":"anthropic","tier":"included",
  "available":false,
  "reason":"Claude CLI reports no authenticated session. Run `claude setup-token` in a terminal."},
 {"id":"codex-default","label":"Codex (CLI default model)","provider":"openai","tier":"included",
  "available":false,
  "reason":"Codex CLI reports no authenticated session. Run `codex login` in a terminal (browser OAuth)."},
 {"id":"kimi-k3", ... "tier":"metered","available":false,"reason":"Metered vendor: billed per token ..."},
 {"id":"deepseek-v4-pro", ... "tier":"metered","available":false, ...}]

POST /api/runs {"ticketText":"Build a one-page site that says hello.","modelId":"default"}
HTTP 409
{"error":"model_unavailable",
 "message":"default is not available: Claude CLI reports no authenticated session. Run `claude setup-token` in a terminal.",
 "remediation":"Authenticate the provider's CLI in a terminal, then try again. No API key is required."}
```

The fix commands are literal: **`claude setup-token`** and **`codex login`**. No
stack trace anywhere. `GET /api/runs` afterwards returned `[]` — the refusal
persisted nothing.

The UI, driving the **production build** with no credentials (headless Chromium,
1280px): all four model radios `disabled: true`, each showing its reason;
"Start run" disabled; the auth panel showing "not signed in" for both providers
with `$ claude setup-token` and `$ codex login` as copyable commands.

Walking every rendered text node (excluding `<script>`/`<style>`, where Next's
RSC payload contains `$`-prefixed markers that are never displayed), the page
contains **exactly two** `$` characters — the two shell prompts:

```
RENDERED text nodes containing '$': [{"text":"$","sibling":"claude setup-token"},
                                     {"text":"$","sibling":"codex login"}]
money-shaped among them: 0
model radios: [{"id":"default","disabled":true},{"id":"codex-default","disabled":true},
               {"id":"kimi-k3","disabled":true},{"id":"deepseek-v4-pro","disabled":true}]
```

Also observed, unprompted: with the API process stopped, the UI renders **"API
unreachable"** rather than an empty or fabricated model list. No page errors in
either state.

**Positive control**, so the refusal is not just a stuck "no": a second server
instance against the machine's real Claude login (`authMethod: "claude.ai"`,
Max) returned `{"ok":true,"claudeAuth":"ok","codexAuth":"missing"}` and a model
catalog read live from the CLI itself — `default`, `opus[1m]`,
`claude-fable-5[1m]`, `sonnet`, `haiku`, all `available: true`, all
`tier: "included"`, with Codex still correctly disabled.

### 1.6 The seal audit, on the dashboard path

Everything below was read in the wired code and, where marked, executed.

| Property | Where it is decided | Verdict |
|---|---|---|
| Suite hashes verified **before** scoring | `SealedScorerGate.score` runs `assertSuiteUsable` then `verifySuiteIntact` and throws `suite_hash_mismatch` before the image is even resolved | **Intact.** EXECUTED via the dry run's one-byte-edit check and `scorer-modes.e2e`. |
| Scorer gets no network | `--network=none` is hardcoded in `scorer.ts`; `assertSealedInvocation` re-checks the argv and rejects conflicting or network-restoring flags (`--net`, `--dns`, `--add-host`) | **Intact.** `gateEnv()` exposes only `PATH`, `HOME`, results dir, acceptance root, image ref, timeout — there is no network knob to override. EXECUTED via the dry run and 3 e2e containers. |
| `agentDeclaredDone` from a structured signal | `readSelfReport(workspace)` → `.bakeoff/self-report.json`, compared `status === "done"` | **Intact.** No prose is parsed anywhere. EXECUTED via the dry run. |
| Builder cannot **write** the held-out suite | permission hook + `sandbox.filesystem.allowWrite` + `materialiseVisibleSubset` refuses a workspace inside `acceptance/` and refuses a visible file that mentions `holdout/` | **Intact.** EXECUTED (unit tests). |
| Builder cannot **read** the held-out suite | see §0 | **WAS OPEN, and the 2026-07-27 close was incomplete — an executed bypass survived it until 2026-07-28.** Now closed on the Anthropic path — every input value judged, canonical case-folded comparison, `file://` and percent-encoding normalised, symlinks resolved by the caller — and still absent on Codex, so: asymmetric. Read §0 before trusting a result, and treat any result dated before 2026-07-28 as unverified. |
| Only the visible half reaches the workspace | `materialiseVisibleSubset` filters `visibility !== "visible"`, flattens the paths so the builder never learns a `visible/` directory existed, and therefore never learns a sibling `holdout/` might | **Intact.** EXECUTED via the dry run. |
| Dashboard records cannot pollute a campaign | `assertOutsideBakeoff` at startup on all four roots; `gateEnv` redirects `BAKEOFF_RESULTS_DIR` / `BAKEOFF_ACCEPTANCE_ROOT` | **Intact.** EXECUTED (2 tests). |

### 1.7 Secrets

- **No key-shaped literal anywhere in either tree**, including
  `dashboard/server/dist`, `bakeoff/dist` and `dashboard/.next`. Searched for
  `sk-ant-*`, `sk-*`, `ghp_*`, `AKIA*`, JWT triples, PEM headers, Slack tokens.
- `bakeoff/.env.example` holds four variable **names** with **zero bytes** after
  each `=`. No `.env` exists in either tree.
- The redaction chokepoint is on every persistence path in the server: `db.ts`
  (every write, including the events table), the run record, the build
  transcript (through `ReassemblingRedactor`, so a credential split across two
  writes still matches), the judge output, and seat-call failure text.
- **Two writes bypassed it and I fixed them**: `results/prompt.txt` and the
  workspace `TICKET.md`. Both embed the ticket text, which here is **free-form
  text you type into a web form** — not a frozen harness-authored brief as in the
  bake-off. The database already stored it redacted; these were second, cleartext
  copies on disk. The provider still receives the ticket verbatim, because the
  ticket *is* the prompt: **do not paste a secret into a ticket.**
  **The bake-off writes both unredacted too** (`runner.ts:527` and `:699`) and I
  deliberately left it alone: its tickets are frozen, harness-authored briefs, so
  the exposure is theoretical there and real here. If you ever point the campaign
  at owner-typed tickets, fix it there as well.

### 1.8 No dollar figure can be produced for a subscription run

- `RunDetail.costUsd` is `null` on every run. There is **no cost column** in
  SQLite. The Agent SDK's own `total_cost_usd` is dropped at the boundary.
- In the UI, `describeCost` is the **only** path to a dollar figure and
  `formatUsd` is called from exactly one branch of it. The `tier: "included"`
  check comes **first**, and that branch's return type carries **no numeric
  field at all** — so a backend that ever attached a figure to a subscription run
  still could not render it as money. This is a compile-time property, not a
  convention.
- The one `0` in the tree (`SUBSCRIPTION_COST_USD`) is a structural zero on an
  internal usage row whose type demands a number; it never reaches the API,
  which sends `null`.

### 1.9 Tests, as run by me

```
bakeoff        npm test                     32 pass, 0 fail
               test/tickets.smoke.mjs       45 assertions
               test/spec-agent.smoke.mjs    107 assertions
               test/ledger.smoke.mjs        104 assertions
               test/subscription.smoke.mjs  146 assertions (live layer 2 skipped)
               test/scorer-modes.e2e.mjs    29/29, real containers
               dry-run                      24/24
dashboard/server  npm test                  41 pass, 0 fail, 2 skipped (quota)
dashboard (UI)    next build                green
```

Re-run on 2026-07-28, after the held-out-boundary pass added 17 tests:

```
dashboard/server  npm test        60 tests, 58 pass, 0 fail, 2 skipped (quota)
                  claude-builder.test.js    26 tests, 26 pass, 0 fail
                  npm run typecheck         clean
```

Re-run again on 2026-07-28, after the second boundary pass (polarity inversion,
canonical case-folded comparison, symlink canonicalisation in the caller) added
16 more tests:

```
dashboard/server  npm test        76 tests, 74 pass, 0 fail, 2 skipped (quota)
                  claude-builder.test.js    42 tests, 42 pass, 0 fail
                  npm run typecheck         clean (exit 0)
```

The 2 skips are the same quota-gated live-smoke tests as on 2026-07-27
(`DASHBOARD_LIVE_SMOKE`), unchanged by either pass. The 2026-07-27 and first
2026-07-28 lines above are left as they were recorded; each was true when
written.

---

## 2. What I FIXED, and what each defect actually was

### 2.1 `/api/health` reported "logged in" for a machine with only an API key

**Severity: this one spends money and hides it.** Measured on this machine, with
an isolated empty `CLAUDE_CONFIG_DIR`:

```
(no key)                -> {"loggedIn": false, "authMethod": "none"}
ANTHROPIC_API_KEY=<junk> -> {"loggedIn": true,  "authMethod": "api_key",
                             "apiKeySource": "ANTHROPIC_API_KEY"}
```

`auth.ts` probed with the **raw** process environment and read **one** field,
`loggedIn`. So with `ANTHROPIC_API_KEY` exported — which `bakeoff/.env.example`
asks you to set — an unauthenticated machine reported `claudeAuth: "ok"`, the
model picker enabled every subscription model, and the build then failed
mid-run, because builds strip that variable. In the other direction it is worse:
the UI promises "Included in your plan" over an identity billed per token.

This was **cross-module drift**. `bakeoff/src/subscription/claude-agent.ts`
already had the guard and the allowlist; `dashboard/server/src/auth.ts` was
written independently and had neither.

Fixed: both probes now run through `subscriptionSubprocessEnv` (the same
environment a build gets), and the Anthropic probe reads `authMethod` against
bakeoff's own exported `ANTHROPIC_SUBSCRIPTION_AUTH_METHODS` — **imported, not
re-spelled**. `api_key` is refused with a reason naming the billing. An
unrecognised method is also refused, naming the observed value, because the
failure direction here is silent spending. `models.ts` now spawns its catalog
probe with the same stripped environment; verified from the SDK's own source
that `options.env` **replaces** the child environment rather than merging over
`process.env` (`env: c = {...process.env}` is a *default*), so a deleted name
stays deleted.

Note which half of the fix does the work in which case. Stripping handles the
common one — a key in the shell. The `authMethod` check handles the one
stripping **cannot** reach: a key supplied by a Claude settings file or an
`apiKeyHelper`, which is not an environment variable and survives everything
`subprocess-env.ts` does. Neither half is redundant.

**EXECUTED**, four states against the real CLI:

```
A  real login, clean env                 -> OK       "authenticated subscription session"
B  empty CLAUDE_CONFIG_DIR, no key       -> MISSING  "Run `claude setup-token` in a terminal."
C  empty CLAUDE_CONFIG_DIR + junk key    -> MISSING  (was OK before the fix)
D  real login + junk key                 -> OK       (key stripped, subscription still found)
```

Plus 9 new unit tests (`auth.test.ts`) driving a stub CLI, including the
`api_key` rejection, the unrecognised-method rejection, a proof that the child
process does **not** receive the stripped names, and a check that no probe detail
ever carries the email, org id or org name the CLI prints.

### 2.2 The builder could read the held-out suite

See **§0**. Two mechanisms were added on the Anthropic driver — the permission
callback and `sandbox.filesystem.denyRead` — and the Codex gap was documented in
the driver itself rather than left to be found. **Do not read that as "two
layers" for a given tool.** Only the permission callback is executed at all
(42 unit tests in `claude-builder.test.ts` as of the second 2026-07-28 pass);
`denyRead` is unexercised in both halves, and whether it binds anything other
than sandboxed Bash is unresolved. For `Read`/`Glob`/`Grep`/MCP the callback may
well be the only layer there is. See §3.

This added a required field to `BuildRequest`. There is **exactly one**
construction site in the tree (confirmed by grepping `\.build\(` across
`server/src` including tests), so no other implementer was left silently
unprotected.

**Superseded 2026-07-28.** That fix was incomplete — it denied only paths
*inside* the suite, only for a hardcoded list of tool names, only when one of
three path keys was present. The bypass it left open, and the three same-class
holes beside it, are in §0. The field is now `sealedRoots: readonly string[]`,
not `heldOutRoot: string`, and it carries two roots: the suite store and
`results/scorer-out`, whose `result.json` persisted `criterionCoverage[].testRefs`
— held-out test titles — outside the sealed store. The single construction site
is `orchestrator.ts:580`.

### 2.3 Two persisted strings bypassed the redaction chokepoint

See §1.7.

### 2.4 The Agent tool was unguarded

`decideToolPermission` inspected only path-bearing tools, so an Agent call fell
through to `{behavior:"allow"}`. That permitted `isolation:"remote"` — running
the build off-host, outside the sandbox, `denyRead`, `allowWrite` and every path
check, with the workspace and ticket text leaving the machine — and left
`run_in_background` at its default of `true`, under which children keep writing
the workspace after the phase returns and the gate scores a moving artefact.

Closed before any delegation was built. `subagent_type` is now an allowlist
enforced at the permission layer, because `Options.agents` limits only what the
orchestrator can see and `subagent_type` is a free string in the SDK schema.

**Live behaviour change you should know about before your next run.** The
allowlist is the guard's optional 5th parameter and defaults to `[]`. The single
production call site (`claude-builder.ts:276`, the only one — verified by
grepping `decideToolPermission` across `server/src`) passes four arguments, so
the shortlist is empty in every real build today and **every `Agent`/`Task` call
is denied**, with a message naming the permitted agents as "(none configured)".
That is intended, not a regression: an empty list means "no delegation
configured", and the denial is what makes the shortlist a boundary rather than a
suggestion. It stays that way until Phase 1 threads a compiled shortlist
through. A build that tries to delegate before then will be refused.

---

## 3. Implemented but UNTESTED — no credentials, or would cost quota

Nothing here has been observed working. **Do not describe any of it as working.**

- **A complete Codex build.** `codex login status` reports "Not logged in" on
  this machine. The whole OpenAI path — thread start, event mapping, usage
  merge, rate-limit detection, resume — has never run against a real session.
- **`rate_limited` as a terminal state from a real rejection.** Only
  `allowed_warning` events have ever been observed.
- **Resume actually continuing a provider session.** The plumbing persists a
  session id and hands it back; that it resumes the conversation rather than
  restarting is unverified.
- **Cancel of a live build.** Cancel of a *queued* run is tested.
- **`deploy: true` through the full pipeline.** `PreviewHost` is unit-tested
  alone.
- **`sandbox.filesystem.denyRead` has still never been exercised, and the
  plumbing claim was an overclaim — corrected 2026-07-28.** This bullet used to
  say "the value reaches the CLI". What
  `src/builders/settings-plumbing.test.ts` actually does is construct its own
  `Options` literal with its own local `heldOutRoot`, hand it to the SDK, and
  assert that same local variable round-trips into the `--settings` payload. It
  never invokes `ClaudeSubscriptionBuilder`, so it cannot detect the builder
  sending the wrong roots, stale roots, or none at all. It proves the SDK
  forwards what it is handed — a property of the SDK, not of this codebase. No
  run has proven the OS sandbox refuses a read either. `denyRead` is the ONLY
  layer covering Bash, because `autoAllowBashIfSandboxed: true` means a
  sandboxed Bash call never reaches `canUseTool`.
- **Whether `denyRead` covers in-process tools is UNRESOLVED.** The typings scope
  filesystem clauses to "within the sandbox"/"sandboxed commands", and state
  explicitly that in-process WebFetch is not gated by the network equivalent. If
  `denyRead` binds only sandboxed Bash, then for `Read`/`Glob`/`Grep`/MCP the
  permission callback is the ONLY layer — not one of two. The Phase 0.5 canary
  probe settles it.
- **The wiring test is a source-shape assertion, not an execution.** It greps
  `claude-builder.ts` for the call shape. It kills the specific mutation that
  went undetected in Phase 0, but a test that drove `ClaudeSubscriptionBuilder`
  against the stub executable would be strictly stronger.
- **Case-folding over-denies on a case-sensitive volume.** A genuinely distinct
  `/x/ACCEPTANCE` would be denied alongside `/x/acceptance`. Deliberate: the
  safe direction for a sealed root.
- **Whether `canUseTool` fires for subagent-originated calls is UNVERIFIED.**
  Inferred from the SDK's `agentID` plumbing and corroborated by
  `SDKPermissionDeniedMessage.agent_id`, but never observed. The Phase 0.5
  canary probe settles both this and the item above in one cheap run. Until it
  does, the Agent-tool guard of §2.4 is proven only as a pure function, not as
  wiring.
- **The judge seat against a real model.** Its parsing is tested against
  fixtures.
- **`DEFAULT_SEAT_CALL_MAX_TURNS = 8`** is a measured floor from one suite, not
  a bound. `DASHBOARD_SEAT_MAX_TURNS` raises it and is named in the failure text.
- **Every named Codex model id.** The dashboard asserts only `codex-default`
  ("whatever the CLI is configured to use"). Anything in
  `DASHBOARD_CODEX_MODELS` is your assertion, not the dashboard's.

---

## 4. REPORTED by a module author, not re-verified by me

Recorded as their word. Where it matters, it is worth re-running yourself.

- A **full pipeline run end to end against the real subscription** (trivial
  static ticket, `sonnet`): spec → build → gate → judge, `heldOutPass=true`,
  `falseFinish=false`, `costUsd=null`, REQ-001..012 all pass, 3 screenshots.
  **I did not reproduce this** — it costs quota, and the task did not ask for a
  live build. **That run predates 2026-07-28, so its `heldOutPass=true` was
  produced under the boundary with the executed bypass and cannot be verified
  retrospectively — see §0.** The rest of the bullet (that the pipeline
  completes end to end) is unaffected.
- That the spec seat runs **with no API key**, `assertUnused()` confirming the
  base HTTP client never dispatched, and that `jsonSchema` is applied rather
  than dropped. The two tests that would prove it are the two skipped by
  default.
- The bake-off blocker fixes D1 (node:test second pass) and D2 (static
  artefacts), and the §1.4 REQ-id attribution fix. **I re-ran their evidence** —
  dry run, `scorer-modes.e2e`, all four smoke suites — and it all passes, so
  these are better supported than "reported". What I did not re-derive is the
  reasoning behind each design choice.
- The UI author's 49 Playwright checks. I re-ran a subset (the no-credential
  path) and it matched.

---

## 5. Before your first real run — checklist

1. **`claude setup-token`**, and **`codex login`** if you want the OpenAI arm.
   `/api/health` must show both `ok` before a run of that provider will start.
2. **Build `bakeoff` first** (`npm install && npm run build`). The server
   imports `bakeoff/dist/*.js`; an uncompiled tree fails at startup with a
   module-resolution error, not with advice.
3. **Build the scorer image** with `--provenance=false --sbom=false`. Without
   those flags BuildKit's attestation moves the digest on every rebuild from an
   identical context, and the digest recorded in every score certifies nothing.
4. **Re-resolve and pin the image digest** after your last edit to `bakeoff/src`
   — any source edit moves it, because stage 1 of the Dockerfile compiles `src/`.
   Today it is `sha256:1c06aa11c425044af4a5dc8cd0b3ff6b7f78e185fd54204c0a8fd810d8074353`.
5. **Read §0.** Decide whether a `heldOutPass` from this tool means what you want
   it to mean, particularly on the Codex path where the read boundary is absent.
   Any `heldOutPass` in your existing data that predates 2026-07-28 is
   unverified — §0 says why, and there is no way to recover the answer after the
   fact.
6. **Delegation is currently denied outright.** The Agent-tool guard added on
   2026-07-28 ships with an empty shortlist, so every `Agent`/`Task` call a build
   makes is refused with "(none configured)". That is deliberate — see §2.4 —
   but if a build reports that it could not delegate, this is why, and it is not
   a credential or a network fault.
7. **Do not paste a secret into a ticket.** The ticket text is sent to the
   provider verbatim, because it is the prompt. On-disk copies are redacted; that
   is a second line of defence, not the first.
8. Expect a **429**. It is a rolling 5-hour window plus a weekly cap, it is a
   normal state, and the run resumes.
9. The first run of a ticket authors and freezes a suite. That costs quota
   before any building happens, and a suite authored under an older prompt is
   not re-authored automatically.
