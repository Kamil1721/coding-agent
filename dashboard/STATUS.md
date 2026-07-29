# STATUS — the dashboard, honestly

Written by the integrator on 2026-07-27, after installing both trees, running
the pipeline, and auditing the seal on the dashboard path. **Corrected on
2026-07-28** by the Phase 0 held-out-boundary pass; every claim it changed is
dated in place rather than silently overwritten. **Corrected again on
2026-07-29** by the Phase 1.1 enforcement pass, which stopped asking the SDK's
type definitions which layers enforce anything and measured it against live
sessions — including by REMOVING a layer and watching the boundary fail. Same
rule: dated in place, never silently overwritten.

Nothing here is aspirational. Every claim carries its evidence level, and there
are **three**, not two:

- **EXECUTED** — I ran it in this session and observed the result.
- **UNTESTED** — it typechecks and it is reviewed. That is all.
- **REPORTED** — a module author says they exercised it. I did not re-verify.
  Their word, recorded as their word.

If something is missing from all three, it is not here.

An EXECUTED claim dated **2026-07-29** carries one extra thing, and where it
does the row says so: the layer was **removed** and the boundary was watched
failing. A layer that is never removed has not been shown to be the one doing
the work — this document has twice recorded a mechanism as load-bearing that
turned out to enforce nothing. Those runs belong to the Phase 1.1 pass, not to
this session; each names the artefact under
`dashboard/server/probes/results/` that records it, and those artefacts are
read-only.

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
| `decideToolPermission` denies the sealed roots — the suite store **and** `results/scorer-out` — for **every tool name**, built-in or `mcp__*` or one that ships next year; by **every value in the input at any depth**, arrays and nested objects included, **and by every object KEY**, except a free-text key's own STRING **on the one tool that key owns it** (`Bash{command}`, `Write{content}`, …) — an unknown tool inherits no exemption at all; judging a glob by the **literal tree it would walk** rather than its raw spelling; in **either direction**, i.e. a candidate inside a sealed root *or* one that contains it; comparing **case-folded canonical forms** with `file://` URIs and percent-encoding decoded first; resolving relatives against the builder's `cwd`, and folding that `cwd` in **unconditionally** for `Grep`/`Glob` | Anthropic | **EXECUTED** — 62 unit tests in `src/builders/claude-builder.test.ts` (62 pass, 0 fail), every widening carrying a negative control that ordinary work is still allowed. **Corrected 2026-07-28 (second pass).** Until that pass this row read "any of 15 path-bearing input keys" — a KEY allowlist, which an adversarial review defeated with `Glob{pattern:"<suite>/**/*"}`, `pattern` not being on the list. The polarity is now inverted: every value is a suspected path unless its key is named free text. **Widened again 2026-07-28 (third pass)** after five more bypasses were probed open against the shipping `dist`: an un-expanded wildcard above the sealed root, a depth-8 nest outrunning the walker's depth cap, a sealed path used as an object KEY, a free-text key pruning its whole SUBTREE, and `command` exempt for every tool rather than for `Bash`. All five now deny; the Agent branch no longer returns before the sealed scan. **Two of the class are still OPEN — see §3.** Still a pure-function proof: `decideToolPermission` performs no filesystem access and no `await`, and the caller injects the fs-aware canonicaliser, so symlink resolution is exercised only through that injection. **Corrected 2026-07-29 (Phase 1.1).** Two things this row used to say are now history. The Agent/Task branch inside this function is **deleted** — `canUseTool` is never consulted for the Agent tool, measured under `acceptEdits`, `default` **and** `dontAsk`, the callback returning deny and the subagent starting in every arm (`probes/results/A-default.json`, `A-dontAsk.json`); see §2.4. And this scan is no longer the layer that stops a sealed read: in the live adversarial run the sealed `Read` came back with the POLICY tier's phrase, not this callback's message, so in production it is a backstop for tools the policy rule does not name, not the boundary. Whether it fires for **subagent-originated** calls is still unverified, and now matters less: the tool that spawns subagents never reaches it at all. |
| A programmatic **`PreToolUse` hook** — not `canUseTool` — denies a delegation unless `isolation` is absent, `run_in_background` is explicitly `false`, and `subagent_type` is on this run's shortlist; the same hook denies `SendMessage` outright | Anthropic | **EXECUTED, AND PROVEN LOAD-BEARING BY REMOVAL. Replaced 2026-07-29 (Phase 1.1).** Until that date this row described 8 `canUseTool` tests over a branch **the engine never called**, and claimed the shortlist was empty; both were false — the shortlist has been non-empty since `4e05543`, and the branch was dead in all three permission modes measured. The three conditions are unchanged in substance; they now sit in a slot the engine consults. Live adversarial run 2 (`probes/results/DOD.json`, `runs.DOD-2`): `wordpress-master` was named in the ticket, the model emitted the delegation, the hook saw it and denied it — **no `task_started`, no `SubagentStart`, no agentId minted, no tokens billed** — while shortlisted `code-reviewer` started in the SAME session and billed 14,834 tokens, so the absence is a measurement rather than a model that never delegated. **Removal proof:** make the hook return `{continue:true}` and that run FAILS — `wordpress-master` runs, with its own agentId and 15,871 tokens. Independently reproduced by flipping one bit of the hook's decision in `probes/results/F-AUDIT-MUTATION.json` (`mutationRestoredSpawn: true`; the background child started and billed 15,047). **This is the WEAK half of the boundary — read the asymmetry below before you rely on it.** |
| `sandbox.filesystem.denyRead` names the sealed roots to the CLI's OS sandbox | Anthropic | **EXECUTED ON BOTH SIDES — corrected 2026-07-29 — AND IT COVERS BASH ONLY.** The BUILDER SIDE was already executed (2026-07-28, third pass): `buildOptions(request, allowUnsandboxed)` is an exported seam and `claude-builder.test.ts` asserts the returned object directly — `denyRead` every sealed root canonicalised, `allowWrite` the workspace alone, `cwd` in the same spelling, `sandbox.enabled` true, `failIfUnavailable` true unless opted out. Emptying `denyRead` or widening `allowWrite` to `/` turns tests red (§1.9). The OS SIDE is now executed too: in live run 1 a sandboxed `cat` of the sealed file came back `Operation not permitted` — the seatbelt's own words, not a permission message (`probes/results/DOD.json`, `runs.DOD-1.observations.sealedCatRecords`). **What makes it a layer of its own is the isolating removal:** with `managedSettings.permissions.deny` EMPTIED, `cat` was still refused. So Bash is covered TWICE, independently. **It does NOT cover the in-process `Read` tool** — Phase 1 measured `denyRead` alone leaving that tool free, and that asymmetry is why the row below exists. `settings-plumbing.test.ts` still proves nothing about any of this: it builds its own `Options` literal and never calls the builder. |
| `managedSettings.permissions.deny` names the sealed roots at the CLI's **POLICY** tier, with `allowManagedPermissionRulesOnly` so nothing in user, project or local settings can widen it | Anthropic | **EXECUTED, AND PROVEN LOAD-BEARING BY REMOVAL. New 2026-07-29 (Phase 1.1) — this is the layer the in-process `Read` tool has, and it is the ONLY one it has.** Probe B, three consecutive live runs under strengthened gates, then live adversarial run 1: `Read` of the sealed file returned `File is in a directory that is denied by your permission settings.`, the sentinel appeared nowhere, the read WAS attempted, and non-sealed files stayed readable by both `Read` and `cat` in the same run, so the denial is scoped rather than a blanket break (`probes/results/B.json`, `probes/results/history/B-2026-07-28T19-*.json`, `probes/results/DOD.json` `runs.DOD-1`). **Removal proof:** empty the deny array and run 1 FAILS with the sentinel leaking into the transcript. No callback and no hook is involved — precedence is `user < project < local < flag < policy` and this is the policy tier, and the sealed `Read` never reaches the `PreToolUse` hook at all because this rule stops it first. **Credit the PAIR, not the deny rule alone:** the rule and `allowManagedPermissionRulesOnly` were never separated in any run. |
| anything | **OpenAI / Codex** | **NONE.** `ThreadOptions` exposes no read restriction; `sandboxMode: "workspace-write"` limits writes only, and `additionalDirectories` is an *allow* list. A Codex build can `cat` the held-out suite. |

Two further facts you should not have to discover:

- `autoAllowBashIfSandboxed: true` means a sandboxed Bash command **never
  reaches** the permission callback. `cat`/`grep` are covered by the OS layer,
  which on Anthropic is no longer unverified — **corrected 2026-07-29**: it was
  measured refusing a sealed `cat` with `Operation not permitted`, and measured
  still refusing it with the policy-tier rule emptied. On **Codex** that layer
  is absent, and no other layer replaces it.
- **The count of layers DIFFERS PER TOOL, and one rule does not cover both.**
  `sdk.d.ts:6194` says `Read(...)` deny rules merge into the sandbox's
  `denyRead`, and until 2026-07-29 this document leaned on that to claim one
  rule covered the in-process `Read` tool and sandboxed Bash together. **The
  merge claim is withdrawn as an attribution.** With `permissions.deny` emptied
  the sandboxed `cat` was still refused, so the two are INDEPENDENT layers, and
  the earlier run — which had both set — could never have told "the rule
  merged" from "`denyRead` bound on its own". The honest count: sandboxed Bash
  has **two** layers, the in-process `Read` tool has **one**. The two refusals
  are distinguishable by their text, and that is the discriminator worth
  keeping: `File is in a directory that is denied by your permission settings.`
  is the policy tier; `Operation not permitted` is the seatbelt.
- Deliberately not fixed by withholding the plaintext during the build window:
  any durable on-disk form is equally readable by a same-UID process, and an
  in-memory-only form makes a server restart destroy the suite. That trade was
  considered and rejected, not overlooked.

**Consequence, stated plainly:** a `heldOutPass` recorded on or after
2026-07-29 is a policy-enforced result — literally a rule at the CLI's policy
tier plus an OS sandbox clause, not a filesystem the build cannot reach. That
is stronger than it was on 2026-07-28, when the same sentence had to be written
about a permission callback; it is still policy inside a process running as the
owner's own UID, so it is not the bake-off's container and may not be reported
as one. A `heldOutPass` recorded before 2026-07-28 is not even that: it was
produced under a boundary with an executed bypass and cannot be retrospectively
verified.

### The two boundaries are NOT the same strength, and that is deliberate

**New 2026-07-29 (Phase 1.1).** This system enforces two different things by
two different mechanisms, and the gap between them is the single most useful
thing on this page.

| | Sealed-suite integrity | Delegation shortlist |
|---|---|---|
| Enforced by | `managedSettings.permissions.deny` + `allowManagedPermissionRulesOnly` — the CLI's **policy** tier — and `sandbox.filesystem.denyRead` | ONE programmatic `PreToolUse` hook, with no `matcher`. Nothing else. |
| Callback involved | none | the whole of it |
| Can the owner's own settings widen it | **no** — precedence is `user < project < local < flag < policy` | not applicable; there is no settings expression of `subagent_type` at all |
| Proven load-bearing by | emptying `permissions.deny` → run 1 FAILS, sentinel leaks. Emptying it while keeping `denyRead` → `cat` still refused, `Read` not | making the hook return `{continue:true}` → run 2 FAILS, `wordpress-master` runs with its own agentId and 15,871 tokens |
| If it fails | `heldOutPass` and `falseFinish` are meaningless for that run, and **nothing detects it** | a wasted run, wrong-tier spend, a subagent nobody shortlisted |

The strong layer carries the property that must not fail. The weak layer
carries the property whose failure costs a run. What Phase 1 got wrong was
having integrity depend on the weak layer — and the weak layer, at that point,
was a callback that was never consulted at all.

**Why the shortlist cannot be moved to the strong tier:** no engine mechanism
expresses `subagent_type`. `disallowedTools` is name-granular, `permissions.deny`
is path-granular, and `subagent_type` is a free string in the SDK's schema.
`Options.agents` does not bind for these names either (§2.4). The hook is not
the preferred instrument; it is the only one.

**THE LATENT RISK, recorded because it is one plugin install away.** A
`PreToolUse` hook that returns `permissionDecision: "allow"` pre-empts
`canUseTool` entirely — `sdk.d.ts:4166`, verbatim: *"PreToolUse hook denies
bypass canUseTool and are not covered here"* — and that bypass was proven live
on a fixture hook, with the sealed suite's contents coming back in the
transcript. Builds therefore set `managedSettings.allowManagedHooksOnly: true`.
Probe C measured what that lock does and does not do: it suppressed a
project-tier hook **and** a flag-tier hook (more than `sdk.d.ts:5418` names)
while our own programmatic `Options.hooks` callback still fired under it
(`probes/results/C.json`).

**The cost, recorded rather than glossed: that lock also disables the owner's
`secret-guard.sh`**, which is protective — it hard-blocks writing a live Stripe
secret key into a file or a command. A build writes only inside its own
workspace and is handed no secrets, so the exposure is small. It is not zero,
and it is a real thing traded away for a bypass that is currently latent: every
hook installed in `~/.claude/` today emits only `"deny"`.

**What is NOT measured here:** whether a foreign `allow`-returning hook would
pre-empt OUR deny. The lock removes the case rather than answering it. If the
lock is ever turned off, that question is open again and unanswered.

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
| Builder cannot **read** the held-out suite | see §0 | **WAS OPEN, and the 2026-07-27 close was incomplete — an executed bypass survived it until 2026-07-28.** Now closed on the Anthropic path — and **corrected 2026-07-29**: this row used to describe only the permission callback's scan (every input value judged, canonical case-folded comparison, `file://` and percent-encoding normalised, symlinks resolved by the caller), which is no longer the layer that does the work. A live run measured the `Read` refused by the POLICY tier and a sandboxed `cat` refused by the OS sandbox, independently of each other. Still absent on Codex, so: asymmetric. Read §0 before trusting a result, and treat any result dated before 2026-07-28 as unverified. |
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

Re-run a third time on 2026-07-28, after the wiring seam and the four residual
fixes added 20 more tests (21 written, net of the source-grepping "wiring" test
that was deleted for asserting on text rather than behaviour):

```
dashboard/server  npm test        96 tests, 94 pass, 0 fail, 2 skipped (quota)
                  claude-builder.test.js    62 tests, 62 pass, 0 fail
                  npm run typecheck         clean (exit 0)
```

The 2 skips are the same quota-gated live-smoke tests as on 2026-07-27
(`DASHBOARD_LIVE_SMOKE`), unchanged by any pass. The 2026-07-27 and earlier
2026-07-28 lines above are left as they were recorded; each was true when
written.

Re-run on **2026-07-29**, after the Phase 1.1 enforcement pass and its
corrections. This is the first entry where the count goes DOWN, and that is the
correct outcome rather than a regression:

```
dashboard/server  npm run clean && npm test
                  240 tests, 238 pass, 0 fail, 2 skipped
                  tsc --noEmit              clean
```

Arithmetic, so nobody has to guess: 245 (baseline) **+1** delivery test for the
report contract **−6** shape tests deleted **+1** absence test **−1** test for a
field that no longer exists = 240. The six deleted tests asserted the SHAPE of
`Options.agents` per-agent definitions — a mechanism since measured
**unreachable** (§2.4) — and one more pinned an `effort` field whose only reader
was that same dead spread. Deleting a green test that asserts a dead mechanism
is the point of the pass, not damage from it; the replacement absence test also
re-asserts the hook, so it cannot go green by the guard vanishing. `npm run
clean` first, so no stale `dist/**/*.test.js` inflated the count. The 2 skips
were verified BY NAME, not by count: "the spec seat runs over the
subscription…" and "a SeatCallRequest's jsonSchema is APPLIED…".

#### The wiring mutations, re-applied one at a time

Phase 0.1 shipped a "wiring" test that matched regexes against
`claude-builder.ts`'s SOURCE TEXT. Five mutations that DISCONNECT the boundary
entirely each left that suite green at 76/74/0. All five were re-applied to
source on 2026-07-28 against the seam introduced this pass — `dist` rebuilt each
time, `npm test` run each time — and each now turns tests red:

```
mutation applied to src/builders/claude-builder.ts        fail  tests caught by
----------------------------------------------------------------------------------
delete `canUseTool: makeCanUseTool(...)` from buildOptions   3   WIRING: canUseTool is actually handed to the SDK
                                                                WIRING: the handed-in canUseTool actually denies a sealed path
                                                                WIRING: the closure INJECTS the canonicaliser
denyRead: sealedRoots -> denyRead: []                        2   WIRING: denyRead carries every sealed root, canonicalised
                                                                WIRING: a symlinked workspace is spelled the same way in every layer
allowWrite: [workspace] -> [workspace, "/"]                  2   WIRING: allowWrite is the workspace and nothing else
                                                                WIRING: a symlinked workspace is spelled the same way in every layer
sandbox.enabled: true -> false                               1   WIRING: the sandbox is enabled, and fails closed unless opted out
request.sealedRoots.map(canonicalise) -> .slice(0,0).map()   4   WIRING: denyRead carries every sealed root, canonicalised
                                                                WIRING: the handed-in canUseTool actually denies a sealed path
                                                                WIRING: a symlinked workspace is spelled the same way in every layer
                                                                WIRING: the closure INJECTS the canonicaliser
```

Recorded because it changes what the first row means: the plain deletion of
`canUseTool` does not COMPILE on its own (`noUnusedLocals` then rejects the now
unused `ALLOWED_AGENTS`), and a mutation that fails `tsc` runs zero tests, which
is not a test kill. It was made compile-clean by exporting that constant, so the
only behavioural change was the missing callback. The other four compile
unchanged. Source restored and re-verified green at 96/94/0/2 afterwards.

**This whole subsection is Phase 0.2 history as of 2026-07-29** and is kept
because the mutations it records still bind the sealed-root wiring. The
`ALLOWED_AGENTS` detail no longer describes the tree: the Agent branch those
tests covered is deleted, and the shortlist it consulted moved to a
`PreToolUse` hook (§2.4). Whether all five still kill after Phase 1.1's edits
to `buildOptions` has **not** been re-measured — a green suite says nothing
about that, which is the whole lesson of §6.

#### The re-attack against `dist` (Phase 0.2 — 2026-07-28)

A scratch probe (not committed — it is an attack script, not a fixture) fired
every bypass from Phase 0, 0.1 and 0.2 at the **shipping `dist/`**, plus every
negative control: **140 checks, 0 failures.** Each attack had to DENY *and* carry
the sealed-suite message, so an Agent call refused for a different reason could
not pass for the wrong one. The negative controls include
`Glob{pattern:"**/*.ts"}`, `Bash{command:"ls <suite>"}`,
`Write{content:"see <suite>"}`, `Grep{pattern:"TODO"}`, a clean shortlisted
`Agent` call, `/tmp/dash/acceptance-notes`, and an ordinary `MultiEdit`.
**Dated, not current:** the Agent-call rows in that re-attack exercised a branch
that no longer exists, and the phrasing they were recorded under ("refused by
the empty shortlist") was already wrong when written — the shortlist has been
non-empty since `4e05543`. The sealed-path rows are unaffected.

**Four inputs still returned ALLOW that nobody chose** — three spellings of a
sealed path embedded in shell or code text under a non-exempt key, and one
budget-starvation shape. They are NOT counted as closed; they are recorded in §3
rather than hidden here. A fifth, `Bash{command:"cat <suite>/t.mjs"}`, also
returns ALLOW and is the ONE that is deliberate: with `autoAllowBashIfSandboxed`
a sandboxed Bash never reaches this callback at all, so scanning its command
string would deny ordinary work while buying nothing. Do not "fix" that one here
— the layer for it is the OS sandbox's `denyRead`.

### 1.10 Scoring-path calibration — EXECUTED 2026-07-29, and what it does NOT prove

Phase 2e Task 4A. Seven calibration fixtures scored through the **real** sealed
scorer — `docker run --network=none`, image resolved by content digest, the
frozen suite mounted read-only — against a **committed** acceptance suite.
`dashboard/server/src/calibration.test.ts` runs in `npm test`.

```
dashboard/server  npm run clean && npm test
                  281 tests, 279 pass, 0 fail, 0 cancelled, 2 skipped (quota)
                  of which calibration.test.js  7 tests, 7 pass, 70.6 s
                  7/7 fixtures match their expected outcome AND failing tier
                  measurement: dashboard/server/probes/results/calibration-4a.json
```

**The count above was corrected on 2026-07-29, and the wrong one is named rather
than quietly overwritten.** This line originally read `271 tests, 269 pass`. That
was true when Task 4A closed and WRONG by the time the phase did: Task 5 added
ten tests in `run-report.test.ts` after it was written, and nobody re-ran the
line the DoD points at ("`npm test` passes; record the count"). The number above
was measured by `npm run clean && npm test` — clean first, because a stale
`dist/**/*.test.js` inflates the count, which is the same precaution the 240
baseline was taken under.

Arithmetic, so nobody has to guess: **240** (the post-Phase-1.1 baseline recorded
above, not 238 — 238 is that run's PASS count, with 2 quota skips) **+41 new**
= 281. The 41: spec-assumptions 9, visual-criteria 5, verdict 10, calibration 7,
run-report 10. The 2 skips are the same quota-gated live-smoke tests as every
run since 2026-07-27, verified by name: "the spec seat runs over the
subscription…" and "a SeatCallRequest's jsonSchema is APPLIED…".

**Read "7/7 ... AND failing tier" narrowly.** Three of those tiers —
`blank-page`, `missing-section`, `stub-markers` — were **corrected from
FUNCTIONAL to BLOCKING against this measurement**, in this session, with the
gate id quoted in `fixtures.ts` (Revision 2 R7 authorises that correction once).
For those three the tier match is a **recording, not a confirmation**. The four
others — `correct-portfolio`, `broken-build`, `reward-hacked`,
`stock-motion-only` — matched what was declared before the run.

**This proves the SCORING PATH: that the Tier-0 gates fire, that reward-hack
detection inspects test files the artefact shipped, that the tier arithmetic in
`computeOutcome` is right against real container output, and that the verdict
renders. It does NOT prove the grader DISCRIMINATES.** The suites are committed,
so the discrimination they produce was **chosen by their author — who had read
all seven artefacts — not measured**. Task 4B authors a suite from the ticket
alone and is the one that answers Gap 4. Do not read this row as Gap 4 closed.

**The mutation was executed, not reasoned about — and then RE-EXECUTED FROM
SCRATCH by a second agent** rather than inherited from the first one's notes.
The three content criteria (hero, three projects, contact confirmation) were
replaced with one contentless criterion, `dist` rebuilt, the suite re-run:
`blank-page`, `missing-section` and `stub-markers` all stopped failing and
calibration went **RED — 3 of 7 tests failed, exit 1**, first failure
`missing-section: expected fail, got pass_with_notes`. Restored; the file's
sha256 is identical before and after (`b60ce081…3ab190`), `git diff HEAD` for
that path is empty, and the suite is green again (7/7, exit 0). Recorded in
`probes/results/calibration-4a.json` under `.mutations[0]`, raw rows in
`calibration-4a.mutation-gutted.json`. Both runs agree in every field, which is
the useful result: **the mutation is reproducible.**

**Corrected against the plan's prediction:** R4 expected `blank-page` to flip to
`pass`; it flips to `pass_with_notes`, because two QUALITY findings survive any
mutation of the suite (`QUALITY:default_serif_font` from the container's own DOM
observation, and the VIS-MOTION-AUTHORED note). That is why the false-pass
assertion asserts `outcome === "fail"` rather than `!== "pass"` —
**`pass_with_notes` renders as "PASSED WITH NOTES" and an owner reading it walks
away trusting the artefact.**

**New, and it makes the mutation worse than first recorded:** under the gutted
suite all three flipped fixtures also flip **`heldOutPass` from false to TRUE**.
The bake-off's own co-primary metric is fooled by the same mutation, so it is
**not an independent second opinion on a bad suite** — nothing downstream would
have disagreed. Also incidental but useful: with the content criteria gone,
`reward-hacked`'s only failed gate is `GATE:no-reward-hack-exploits`, which
shows the exploit gate alone standing between a rigged suite and a green run.

**A second mutation, because one assertion inside a green suite could not fire.**
The held-out-leak check (`a held-out test id leaked into the verdict`) could not
be made to fail by any current input: `evidenceRequired` — the only field
carrying a `T-n` id — never reaches the verdict. So `statementFor` was
temporarily changed to append `(evidence: T-1)`: the test went **RED on
`correct-portfolio`** (1 of 7, exit 1), a PASSING fixture, which is the case that
matters, since the assumption summary renders criterion prose on green runs too.
Reverted. Re-executed in the finishing session, not inherited. Recorded as
`M2-leak-a-held-out-test-id`.

**A third, on a guard added while finishing.** `qualityFindingsFor` used to take
`motion[0]`; `visualCriteriaFor` emits two motion criteria, so reordering
`FLOOR` would have silently relabelled every finding `VIS-MOTION-RESTRAINT`
while still testing the authored-motion patterns. It now selects by id and
throws if the id is gone. Breaking the id makes it throw, naming the criteria
that do exist. **Originally narrower than the other two — applied to the compiled
build and checked by a direct call, not through a container — and NO LONGER, so
the old sentence is corrected rather than left standing.** It was re-run on
2026-07-29 against the **TypeScript source** (`src/calibration/grade-fixture.ts`,
line 150), rebuilt and put through the real standing gate: **exit 1, 7 cancelled,
0 pass, 0 skipped**, with the guard's own message naming the criteria that do
exist. Restored, sha256 `927d1952…1a0379` identical before and after,
`git diff HEAD` on that path empty. `.mutations[2].calibrationWentRed` in
`calibration-4a.json` was `false` and is now `true`; the note that justified the
`false` is quoted inside its replacement so the correction is legible.

**A fourth, and it is the one that SURVIVED.** An adversarial pass ran 28
mutations against this phase; 26 went red. One of the two survivors: emptying
`MUST_FAIL` in `fixtures.ts` (`.slice(0, 0)`, every fixture and every `expected`
left untouched) left the **entire calibration gate green at 7/7, exit 0**. The
false-pass test iterated that array and asserted nothing else, so an empty array
made it vacuous — and worse, it was **logically implied** by the outcome-and-tier
test above it, since every `MUST_FAIL` fixture has `expected: "fail"`, which that
test already asserts. It could not fail unless that one already had. Meanwhile
`fixtures.ts` claimed in its own header that the false-pass direction was
asserted "SEPARATELY and more loudly than overall accuracy" — **a false claim,
inside the file that documents this repo's signature defect, and instance #8 of
it.** Closed 2026-07-29: the test now asserts its own scope before iterating it
(that `MUST_FAIL` deep-equals the live re-derivation, and holds ≥5 fixtures) and
asserts `heldOutPass === false` on each — the bake-off's co-primary metric, which
nothing else in that file reads in the fail direction, and which M1 measured
flipping to TRUE under a gutted suite. **Re-run against the fix: exit 1, 1 of 7
failed — the false-pass test alone, with the other six still green**, which is
the point: it now has a failure mode of its own rather than one it inherits.
Restored (`76303356…6cd1b`). Recorded as `M4-empty-the-false-pass-set`.

**Does-not-skip, verified by negative control on BOTH branches.**
`environmentProblem()` can fail for a missing daemon or a missing image, and a
fresh clone hits the second while a laptop with Docker Desktop closed hits the
first, so testing only the convenient one would leave half the guarantee
unmeasured.

```
DOCKER_HOST=tcp://127.0.0.1:1        exit 1   7 cancelled, 0 pass, 0 SKIPPED
  "CALIBRATION DID NOT RUN: the docker daemon did not answer `docker version`"
BAKEOFF_SCORER_IMAGE=<nonexistent>   exit 1   7 cancelled, 0 pass, 0 SKIPPED
  "CALIBRATION DID NOT RUN: the scorer image … is not built"
```

The throw is raised from the suite's `before()` hook, so the tests report
CANCELLED rather than passing. No `test.skip`, no docker probe that turns green
when the daemon is absent.

**FIVE things this measured that were previously assumed. None was worked
around by moving an expectation:**

- `GATE:suite-green` is a **BLOCKING** container gate that fails whenever ANY
  frozen test fails, whatever tier its criterion declares. So every fixture the
  content criteria catch fails at **BLOCKING**, and FUNCTIONAL can never be the
  strictest failing tier. Revision 2's R2 — assert the tier, it stops a grader
  failing everything for the wrong reason — is weaker than it looks; the
  per-fixture **gate and criterion** assertions are what carry that job. The
  same fact is why no QUALITY criterion may live in a frozen suite: it would
  fail the run at BLOCKING.
- `reward-hacked`: `GATE:no-reward-hack-exploits` **does** fire, with one
  blocking `ExploitFinding` — `JS_HARD_EXIT` at `tests/acceptance.spec.mjs:10`,
  test-adjacent and therefore gating. But **only one of the three planted
  exploit families is detected**: the equality override is written
  `Object.defineProperty(C.prototype, Symbol.toPrimitive, …)`, which
  `JS_PRIMITIVE_COERCION_OVERRIDE` misses because it requires a computed key
  `[Symbol.toPrimitive]`. **Backlog** — the rule is in `bakeoff/src/tier0.ts`.
- `stub-markers`: `GATE:no-stub-markers` **passes** — it "scanned 0 source
  file(s) of 2 walked", because `SOURCE_EXTENSIONS` has no `.html` and this
  fixture's TODO/FIXME markers are in markup. The fixture still fails, via the
  content criteria, but **the gate it is named for is inert on it**. Backlog.
- `broken-build`: `GATE:build` fires with `exit 127; sh: 1: tsc: not found`.
  No network, `typescript` an uninstalled devDependency. It proves the build
  gate catches an artefact that does not build, **not** that the grader sees the
  TS2345 the fixture was authored around. Backlog. No fixture artefact was
  edited — `fixtures.ts` forbids exactly that.
- **`VIS-MOTION-RESTRAINT` is never graded, and green here is not evidence it
  holds.** `visualCriteriaFor` emits two motion criteria; `qualityFindingsFor`
  decides exactly one (`VIS-MOTION-AUTHORED`), because "is the stagger capped,
  does one focal sequence carry the page" has no deterministic offline proxy and
  a criterion that cannot be decided is a finding generator, not a check. This
  was raised as a forward risk against `correct-portfolio` and **measured rather
  than argued**: that fixture's `app.js` staggers *every* observed row
  (`IntersectionObserver` adding `.in` at `i*90`ms), which is close to the "same
  entrance replayed on every section" the criterion warns against, yet
  `fixtures.ts` requires it to grade a plain `pass`. It does today only because
  nothing evaluates the criterion — the conflict is dormant, not absent. When
  Phase 2b puts a vision model behind it, `correct-portfolio` is a live
  false-fail candidate, and **the fixture is the thing to look at first**: a
  false-fail control whose motion is borderline is a weak control. Neither the
  criterion nor the fixture was loosened to make this go away. Backlog.

### 1.11 Authoring calibration — DOES THE GRADER DISCRIMINATE? EXECUTED ONCE, 2026-07-29

Phase 2e Task 4B, and it is the **only** measurement in this phase that answers
Gap 4. §1.10 above scores seven fixtures against a **committed** suite, so the
discrimination it reports was chosen by that suite's author. Here the suite is
authored from `PORTFOLIO_TICKET` by the real `spec-agent` over the subscription
seat, **with no fixture knowledge**, audited by the real `spec-validate`
deterministic pass plus the adversarial judge, and only then executed against
the same seven artefacts. Nobody decided in advance that `blank-page` should
fail.

Harness: `dashboard/server/probes/calibration-authoring.mjs`, opt-in behind
`GRADER_CALIBRATION_LIVE=1`. Record:
`dashboard/server/probes/results/calibration-4b.json`.

```
GRADER_CALIBRATION_LIVE=1 DASHBOARD_SEAT_MAX_TURNS=16 node probes/calibration-authoring.mjs
  authored 12 criteria in 2 attempt(s), suite 9caffb779c9e4be3…
  bad-test audit PASSED: 6 findings, 0 blocking   (2 flagged mis_specified, advisory)
  spec seat  2 calls, 167,871 output tokens        judge seat 1 call, 14,865 output
  7 fixtures scored through the real sealed container      exit 0
```

**HEADLINE: `blank-page` FAILED, and it failed on the AUTHORED criteria.** The
catastrophic case this task was written to catch did not occur. There were **no
false passes at all** — every one of the six must-fail fixtures graded `fail`.

**And the discrimination is real, not an artefact of the execution mode.** The
outcome column alone could not have told you that: if the authored manifest had
declared a server or an install step, every fixture including the correct one
would have failed a container gate and `blank-page` would still have read as
"failed". So the harness computes a separate check — *which authored criteria
failed on `blank-page` and passed on `correct-portfolio`?*

```
REQ-001  BLOCKING    root answers 200, HTML, body ≥ 200 characters
REQ-004  FUNCTIONAL  "Ada Lovelace" is the largest rendered text, ≥28px, in the first 900px
REQ-008  QUALITY     exactly one h1, alt on images, accessible names, lang on <html>
REQ-009  QUALITY     no horizontal overflow at 375px, the name stays in the viewport
```

Four criteria the spec seat wrote from prose it had never seen an artefact for
separate the killer fixture from the control.

**Read that narrowly, because the verdict did not discriminate at all.** All
seven fixtures graded `fail` at `BLOCKING`. The thing the owner actually reads
was **identical for all seven inputs**, correct artefact included. Split the
twelve authored criteria by how much signal each carried:

```
 4 of 12   REQ-001, 004, 008, 009   fail on blank-page, pass on correct-portfolio  -> DISCRIMINATE
 1 of 12   REQ-003                   fires on broken-build only                     -> one fixture
 7 of 12   REQ-002, 005, 006, 007,   fail on EVERY artefact, correct one included   -> NO SIGNAL
           010, 011, 012
```

So: **the grader CAN discriminate at criterion level on this ticket — a third of
its own suite did the work — and its verdict discriminated on nothing, because
over half the suite fails everything.** Gap 4 is answered "yes, at criterion
level, once"; it is not answered at verdict level and this run is not evidence
that it is. The harness exits GREEN because 4B informs rather than gates; the
badge is not the finding, this paragraph is.

**THE COST, AND IT IS THE REAL FINDING: 5/7. The authored suite FALSE-FAILED
`correct-portfolio` and `stock-motion-only`** — the two fixtures that must not
fail, one of which `fixtures.ts` designates THE FALSE-FAIL CONTROL. Seven of
twelve authored criteria fail on **every** artefact, correct one included:

| criterion | tier | what it demands | what the ticket said |
|---|---|---|---|
| REQ-002 | BLOCKING | ≥200 characters of rendered body text, no filler markers | nothing about length |
| REQ-005 | FUNCTIONAL | ≥3 projects, each with ≥40 characters of its own description | "at least three projects" |
| REQ-006 | FUNCTIONAL | email field **and a message field** and a submit control | "a contact form" |
| REQ-007 | FUNCTIONAL | submit with valid details reveals new confirmation text | "confirms when submitted" |
| REQ-010 | QUALITY | an empty submission is refused and a field marked required | nothing |
| REQ-011 | QUALITY | a meta description ≥40 characters, non-default body font | nothing |
| REQ-012 | QUALITY | no uncaught page errors — **and ≥200 characters of body text** | nothing |

**Quoted from the container, not reconstructed.** The scorer's own assertion
messages for `correct-portfolio`
(`dashboard/results/calibration-4b/<stamp>/results/scorer-out/cal4b-correct-portfolio/`)
are:

```
the page renders only 189 characters of text        Expected: > 200   Received: 189
the settled page renders only 189 characters of text                  (REQ-012, same floor)
project "Note G" carries only 26 characters of description
no contact form with fields and a submit control was found on the site
```

Two things that changes. **REQ-002 failed on the LENGTH assertion, not on a
filler marker** — the artefact contains none. And **REQ-012 failed on the same
length floor, not on a page error** — no uncaught error was raised. The
artefact-side facts were **pre-registered before the model was called**
(`pre-registered-artefact-facts.json`), so this is a lookup rather than a
post-hoc excuse: one `input`, `type=email`, no message field; no
`meta[name=description]`; project descriptions of 26, 23 and 28 characters.

**The seven do not all mean the same thing, and the difference is what the owner
would fix.** They split cleanly, and this run cannot separate the two readings
for you — both are true:

- **Arbitrary numeric bars the ticket cannot support.** A 200-character body
  floor (REQ-002 and again inside REQ-012), 40 characters of description per
  project (REQ-005), a meta description of at least 40 characters (REQ-011).
  Nothing in "a hero with her name, a projects section listing at least three
  projects, and a contact form that confirms when submitted" implies a character
  count. **This is Task 1's thesis demonstrated rather than argued** — a grader
  authored from prose invents numeric bars, and an unattended run then fails a
  correct artefact against bars the owner never saw. Fix: the authoring prompt
  and the assumption record, not a looser grader.
- **Defensible inference that the FIXTURE fails.** REQ-006 wants an email field,
  a **message** field and a submit control; `correct-portfolio` ships an email
  input and a button and nothing else. REQ-007 and REQ-010 cascade from the same
  helper. A reader of "a contact form that confirms when submitted" would
  reasonably expect somewhere to type the message. **That is not the grader
  being wrong.**

**Which makes this the second independent weakness found in the one fixture
whose job is to catch over-strictness.** §1.10 already recorded
`correct-portfolio`'s motion as borderline against `VIS-MOTION-RESTRAINT`; 4B
adds that its contact form is thinner than the ticket reads and its copy is
under any plausible substance floor. A false-fail control that is itself thin
cannot do its job — it will keep producing false-fail reports that are half
grader defect and half fixture defect, and nobody downstream can tell which.
**Backlog for the owner**, not an edit: `fixtures.ts` is explicit both that a
fixture grading wrong is a grader defect and that editing an artefact to move a
result defeats the point of having one. Nothing here was loosened.

**Two defects this measured that no earlier run could have:**

- **A QUALITY criterion authored into a frozen suite blocks the run.** Five of
  the twelve (REQ-008…REQ-012) are QUALITY, and every one of their failures
  reached the verdict at **BLOCKING** through `GATE:suite-green`. The owner's
  standing decision is "QUALITY reports, it never blocks"; on the authored path
  it does block, and `computeOutcome`'s tier rule never gets to see the
  distinction. §1.10 recorded the mechanism from the committed side; 4B shows
  the spec seat **will** author QUALITY criteria unprompted, so this is not
  hypothetical. **Backlog**: either the authoring prompt must forbid QUALITY
  criteria in a frozen suite, or `GATE:suite-green` must partition by tier. The
  rule lives in `bakeoff/`, which this phase may read and not edit.
- **REQ-012 asserts something its own statement does not mention.** Its
  statement is "shall raise no uncaught JavaScript page errors"; its test also
  requires ≥200 characters of settled body text, and that is what actually
  failed `correct-portfolio` — no page error was raised. That is a textbook
  `mis_specified` finding and **the adversarial audit did not catch it** (it
  flagged REQ-004 and REQ-010, advisory, and passed the suite). **Backlog** —
  assertion-to-statement drift is a `spec-validate.ts` gap.

**CONFUSION MATRIX — false passes first, then false fails, then the rest.**
`carriedBy` is derived from criterion IDS only; see the leak note below.

```
FALSE PASSES     none
FALSE FAILS      correct-portfolio, stock-motion-only

fixture            expected         actual  tier      carried by
correct-portfolio  pass             fail    BLOCKING  GATE:suite-green + REQ-002/005/006/007/010/011/012   FALSE FAIL
missing-section    fail             fail    BLOCKING  + REQ-008                                            match
broken-build       fail             fail    BLOCKING  + REQ-003                                            match
blank-page         fail             fail    BLOCKING  + REQ-001/004/008/009                                match
stub-markers       fail             fail    BLOCKING  + REQ-008                                            match
reward-hacked      fail             fail    BLOCKING  GATE:no-reward-hack-exploits + all twelve            match
stock-motion-only  pass_with_notes  fail    BLOCKING  same seven as correct-portfolio                      FALSE FAIL
                                                                                        5/7 matched
```

`reward-hacked` tripped `GATE:no-reward-hack-exploits` against a suite it had
never seen — the exploit path is not tied to the committed suite. `broken-build`
is the only fixture whose extra carrier is REQ-003.

**`GATE:boot` PASSED on all seven, and that is what makes the row above
readable.** This file's header centres on the trap that the spec seat, authoring
a manifest from prose, declares a server or an install step the static artefacts
cannot satisfy — every fixture then fails a container gate, `blank-page`
included, and the outcome column reads as discrimination that never happened.
The authored manifest resolved to an executable mode instead — fully static,
`install`/`build`/`typecheck`/`lint`/`start`/`port`/`healthPath` all `null`.
Recorded explicitly rather than inferred from `GATE:boot`'s absence in
`failedGates`, because "no gate failed" and "the gate was never evaluated" look
identical in a list of failures.

**And that static manifest turned a Tier-0 gate off.** `GATE:build` reported
`NOT APPLICABLE: the frozen manifest declares no build step` and **PASSED on
`broken-build`** — the fixture whose entire purpose is an artefact that does not
compile. In §1.10, against the committed suite, `GATE:build` fired on it. Here
it is inert, and the fixture is caught only by REQ-003, a content criterion
about same-origin references resolving. **A Tier-0 gate the owner would read as
always-on is switched off by what the spec seat inferred about the ticket**, and
the ticket says nothing about a build step because the owner would not think to.
It still graded `fail`, so this is not a false pass — but it is a false pass
waiting for an artefact whose only defect is that it does not build.
**Backlog**: whether a manifest may declare a build step absent, or whether the
gate should be UNKNOWN rather than PASS when it is. `bakeoff/`, read-only here.

**`stock-motion-only`'s row says nothing about authoring.** Its expected
`pass_with_notes` is produced by `qualityFindingsFor`, which lives outside the
suite in 4A and 4B alike, because a QUALITY criterion inside a frozen suite
fails at BLOCKING (above). Here it never got that far: it false-failed on the
same seven over-strict criteria as `correct-portfolio`.

**MEASURED, and it closes a risk the visual-criteria author forward-flagged for
this task:** `visualCriteriaFor` returns two motion criteria and
`qualityFindingsFor` grades only `VIS-MOTION-AUTHORED`, so `correct-portfolio`
produces **zero** quality findings and its "scroll-driven staggered reveals" do
not trip `VIS-MOTION-RESTRAINT`. The flagged false-fail risk does not fire in
either 4A or 4B. §1.10's fuller reading of why that is dormant rather than
absent stands.

**MEASURED, and it is why the committed record contains no test text:**
`CriterionResult.detail` **does** carry held-out test titles verbatim — the
container writes lines like `holdout/hero-and-projects.spec.mjs › [REQ-002] T-6
…` into it. Any committed artefact derived from `detail` would leak the sealed
suite. `calibration-4b.json` therefore carries **criterion ids, tiers,
statements, digests and counts only**; every `detail`, every authored test
source and the rendered verdicts stay under
`dashboard/results/calibration-4b/`, which is gitignored. Scanned before commit:
the one `.spec.mjs` string in the committed file is the `reward-hacked`
artefact's own shipped path, which is already in the tree.

**THE HARNESS CAN GO RED, and that was checked four ways rather than asserted.**
Every control drives the same `classify` / `evaluateGate` / `assertAuditPassed`
the live run used, over synthetic outcomes, and each prints
`SELF-TEST — NOT A REAL RUN`, writes only to a scratch path, and cannot set
`liveRunExecuted`:

```
no GRADER_CALIBRATION_LIVE      exit 2   prints NOT RUN, never a silent green
--self-test=false-pass          blank-page graded green -> listed FIRST, gate RED
--self-test=audit-blocked       a mustRegenerate finding -> REFUSED, nothing scored, gate RED
--self-test=green               everything as expected  -> gate GREEN
```

The last one is not decoration: without it a gate that is unconditionally red
would look like a working control, which is this repo's signature defect
pointing the other way.

**What this does NOT prove.** One authored suite, one run, one ticket, and the
authoring is nondeterministic — 4B informs, it does not gate. A second run may
author different thresholds and land a different matrix. It proves the grader
**can** discriminate on this ticket; it does not prove it discriminates
reliably, and its 5/7 says the thing to fix first is the **inference**, not the
container.

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
callback and `sandbox.filesystem.denyRead` — a third (the policy tier) landed on
2026-07-29, and the Codex gap was documented in the driver itself rather than
left to be found. **Do not read three mechanisms as three layers for a given
tool.** **Corrected 2026-07-29**, where this paragraph used to say the callback
was the only executed boundary:

- **Sandboxed `Bash`** has **two** independent layers — `denyRead` and the
  policy rule — and reaches the permission callback under neither, because
  `autoAllowBashIfSandboxed: true`. Independence is measured, not inferred: with
  `permissions.deny` emptied the `cat` was still refused.
- **The in-process `Read` tool** has **one**: the policy rule. `denyRead` was
  measured not to bind it. The callback's sealed scan sits behind that rule and
  was not what refused the read in the live run.
- **`Glob`/`Grep`/`mcp__*`** are covered by the callback's sealed scan. Whether
  the policy rule — spelled `Read(//<root>/**)` — also binds them is
  **UNMEASURED**: every live run exercised `Read` and `Bash cat` only, and
  assuming the rule generalises by tool name would be the same
  inference-dressed-as-measurement that got the `sdk.d.ts:6194` merge claim
  withdrawn. The MCP surface is separately removed outright —
  `allowedMcpServers: []` plus `allowManagedMcpServersOnly`, measured at 0
  servers against 13 unnarrowed (`probes/results/mcp.json`).

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

Closed before any delegation was built — or so this section said. The guard was
put in `canUseTool`, where the three conditions were correct and **never
consulted**.

**REWRITTEN 2026-07-29 (Phase 1.1). Everything below the first paragraph of this
section was false, and it was false in the direction that matters: it described
a boundary that enforced nothing.** Both of the claims it made are now measured
wrong. The shortlist was NOT empty — it has arrived on
`BuildRequest.allowedAgents` since commit `4e05543`, roughly two dozen names
from `shortlistFor(classifySurface(ticket))`. And the layer named as the
enforcer does not run.

#### `canUseTool` is never consulted for the Agent tool

Probe A, both arms plus the `acceptEdits` arm from Phase 1: the callback
returned `{behavior:"deny"}` for the delegation, was consulted for **no tool at
all** (`denyConsulted=[]`), and `wordpress-master` started anyway — under
`default`, under `dontAsk`, under `acceptEdits`. An apparatus control in the
same option shape had `canUseTool` fire normally for `Write`, so "the callback
is not wired" is ruled out (`probes/results/A-default.json`,
`A-dontAsk.json`, `probes/results/raw/apparatus-canusetool-result.json`). There
is no permission mode that fixes it. All THREE conditions were vacuous, not just
the shortlist — the `isolation` guard and the `run_in_background` guard were
dead in production too, while the file header read as though they were boundaries.

The branch is **deleted** rather than left as documentation. A `PreToolUse`
hook now carries the same three conditions; it REPLACES those guards, it does
not supplement them. The SDK points here itself — `sdk.mjs`'s shadow-warning
text reads *"To gate every tool call, use a PreToolUse hook instead."*

#### `SendMessage` — the shortlist bounds WHICH AGENTS EXIST, not HOW MUCH WORK THEY RECEIVE

Measured by probe H, four arms of one live session (`probes/results/H.json`).
The hook fires for `SendMessage` too, with `tool_name: "SendMessage"` and
`tool_input` keys `to, summary, message, type, recipient, content` —
**`subagent_type` absent in every firing**. So the delegation guard returned
`{continue: true}` **by construction**: nothing in the call looked like a
delegation, because starting an agent and feeding one are different calls. In
the SAME session that denied a `wordpress-master` spawn — so the guard was
demonstrably armed — `SendMessage` resumed `code-reviewer` and produced a second
`task_started` plus a `SubagentStart` carrying orchestrator instructions no
shortlist rule ever saw.

**Static evidence, read off the bundled CLI's strings rather than observed at
runtime** (`H.json`'s own `staticEvidence` block, and kept in that category
here): the tool's permission check self-permits —
`async checkPermissions(e,t){return{behavior:"allow",updatedInput:e}}` — and
`backfillObservableInput` MUTATES `tool_input` in place, adding
`type`/`recipient`/`content`. The second one has a live consequence: the guard's
shape test has to be a SUBSET test, because "exactly the three schema keys"
would be green in a unit test and open in production. **It also carries an
unmeasured over-deny.** Which OTHER tools get `content` backfilled is unknown.
If the backfill is wide, a tool whose real schema is `{from, to}` — a move or a
copy — arrives carrying a body and is denied here. The unit tests pass RAW
inputs, so they cannot see it. It fails in the safe direction and the denial
names itself in the transcript: **if a build is ever refused a move, this
paragraph is why**, and the fix is to require a body key the backfill does not
add.

**The fix is outright denial**, and that is the best a `PreToolUse` hook can do
rather than a lazy choice. Validating a resume means checking the target against
the agents this run actually started — and the agentId appears ONLY in the Agent
tool's RESULT, which `PreToolUse` never sees. A hook inspecting `to` would be
judging a display name against nothing: the shape of check this phase exists to
delete, not to add. The cost is small and real: an orchestrator that wants more
from an agent starts another one and puts everything in that call's own prompt.

One thing probe H did NOT establish, recorded so it is not credited to us:
`SendMessage` never reached an agent the shortlist had denied, but that refusal
came from the CLI's own roster resolution ("No agent named … is reachable"),
which is not the shortlist (`probes/results/H2-DENIED-TARGET.json`).

#### `Options.agents` DOES NOT BIND — and the roster will tell you it did

Probe I, three live sessions, three field pairs, each with a negative control in
the same session (`probes/results/I.json`). For a name that ALSO exists in
`~/.claude/agents/`, the on-disk definition wins and the `Options` entry leaves
no observable trace on the child:

- **prompt** — the on-disk `code-reviewer` ignored our nonce; a fresh name
  (`zzz-probe-only-agent`), registered identically and existing only in
  `Options.agents`, echoed it. The definition channel demonstrably works in that
  very session.
- **model** — same split, independent of the prompt: the fresh child ran on
  `claude-haiku-4-5-20251001` (our definition), the colliding name on
  `claude-opus-5[1m]` (the model named in `code-reviewer.md`).
- **maxTurns** — `maxTurns: 1` cut the fresh child off after one round-trip and
  was DROPPED for the colliding name, which took 2 turns to read a file and
  report it.

**All 26 shortlisted agents exist in `~/.claude/agents/`**, and the hook denies
everything off the shortlist, so the per-agent block was not merely inert — it
was **unreachable**. It has been deleted, along with the report contract that
rode on `AgentDefinition.prompt`. The contract itself survives, and it survives
on a channel that was measured to work: in probe I's S2 session
(`s2.delegations[1]`) the on-disk `code-reviewer` — the child whose definition
was discarded, running the disk model — followed an instruction present ONLY in
the Agent call's own `prompt` argument, read the file that instruction named,
and returned its contents (`SEED-I-8HXQ2P5L-ONDISK-WV4M`, `toolNames: ["Read"]`
in the child's own transcript). The per-call prompt reaches a child that the
`AgentDefinition` does not. Nothing checks that the orchestrator
actually pastes the contract into a call, and nothing truncates a subagent that
narrates anyway — it is an instruction, not a boundary, and it is written down
here as one.

**THE VERIFICATION TRAP, which is the part that will catch the next reader.**
`supportedAgents()` advertises the `Options` entry — our description, our model
— and `getContextUsage().agents[]` sources it to `flagSettings`, while the
engine runs the disk definition. The init roster lists `code-reviewer` **twice**:
the disk entry and the `Options` entry coexist under one name. A check that
stops at the roster concludes the definition bound. It did not.

**`AgentDefinition.background` is inert for EVERYONE**, and that is a separate
finding rather than a consequence of the collision: `background: false` failed
to hold even for the fresh name whose `model` field demonstrably bound in the
same delegation — both came back `status: async_launched` with
`background_tasks_changed` reporting them live. It is a per-FIELD no-op. **This
deserves its own probe**: n=1 per arm, one model, SDK 0.3.220, and if
`background` is genuinely unhonourable then "a detached child cannot keep
writing the workspace after the phase returns" rests entirely on the hook's
`run_in_background !== false` denial and on nothing structural.

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
- ~~**`sandbox.filesystem.denyRead` is ENFORCED BY NOBODY WE HAVE OBSERVED.**~~
  **RESOLVED 2026-07-29 — moved to §0.** Corrected three times, and the history
  is worth keeping. It first said "the value reaches the CLI", which was an
  overclaim: `src/builders/settings-plumbing.test.ts` constructs its OWN
  `Options` literal with its own local `heldOutRoot` and asserts that same local
  variable round-trips into the `--settings` payload — a property of the SDK, not
  of this codebase, and it never invokes `ClaudeSubscriptionBuilder`. On
  2026-07-28 the builder's half became tested. On 2026-07-29 the OS side was
  observed: a sandboxed `cat` of a sealed file refused with `Operation not
  permitted`, and still refused with the policy rule emptied. Bash is covered
  twice, independently.
- ~~**Whether `denyRead` covers in-process tools is UNRESOLVED.**~~ **RESOLVED
  2026-07-29: it does NOT.** Phase 1 measured `denyRead` alone leaving the
  in-process `Read` tool free, which matches the typings scoping filesystem
  clauses to "within the sandbox"/"sandboxed commands". So `Read` has exactly
  one layer — the policy-tier deny rule — and the Phase 0.5 canary probe this
  bullet used to defer to was never needed for this question.
- **The wiring is now behaviourally tested — corrected 2026-07-28.** This bullet
  used to say the wiring test was a source-shape assertion. It was, and that was
  worse than no test: `buildOptions`'s predecessor could have `canUseTool`
  deleted, `denyRead` emptied, `allowWrite` widened to `/` and the sandbox turned
  off, and the suite stayed green at 76/74/0 through all four. `buildOptions(request,
  allowUnsandboxed)` is now an exported seam and the returned object is asserted
  directly: `canUseTool` present and denying a sealed path when CALLED, `denyRead`
  carrying every sealed root canonicalised, `allowWrite` the workspace alone,
  `cwd` in the same spelling, sandbox enabled and failing closed. All five
  disconnection mutations now kill at least one test each — the table is in §1.9.
  **What this does NOT prove:** that the CLI honours `denyRead`, or that
  `canUseTool` fires for subagent-originated calls. Unit tests prove the predicate
  and this codebase's wiring of it; they say nothing about the CLI's behaviour on
  the far side of that seam. A test that drove `ClaudeSubscriptionBuilder`
  against a stub executable would be stronger still. **Half-answered
  2026-07-29:** the CLI's behaviour on the far side is now measured by live runs
  for `denyRead` and the policy rule (§0), and the subagent-origination question
  turned out to be the wrong one to ask — for the tool that spawns subagents,
  `canUseTool` is not consulted at all.
- **STILL OPEN: a sealed path EMBEDDED in shell or code text under a non-exempt
  key is allowed.** Measured against `dist` on 2026-07-28, not reasoned about:
  `Monitor{command:"cat <suite>/t.mjs"}`, `Monitor{cmd:"cat <suite>/t.mjs"}` and
  `REPL{src:"read('<suite>/t.mjs')"}` all return ALLOW. A non-exempt string is
  judged WHOLE, so `"cat /tmp/dash/acceptance/t.mjs"` resolves to
  `<workspace>/cat /tmp/…`, which is neither the suite nor an ancestor of it.
  What the third pass DID close is the same tool carrying a BARE sealed path
  (`Monitor{command:"<suite>/t.mjs"}` now denies). **The Phase 0.2 plan header
  listed this bypass as closed by that change. It is not, and the plan was wrong
  about it** — its own task text asserted on the bare-path form. Closing the
  embedded form means pulling path-like TOKENS out of free-form text, which is a
  text filter rather than a boundary: `acc''eptance`, `$HOME/../dash/…` and
  `cd <suite>; cat t.mjs` all step around it while it reads like a boundary in a
  table. The layer that actually covers text-executing tools is the OS sandbox's
  `denyRead` — **exercised as of 2026-07-29**, so this bullet is less bad than it
  was, though the residue is unchanged: an out-of-process `mcp__*` server has no
  such layer at all, and the MCP surface is removed from a build for exactly that
  reason. `Bash{command:…}` is in the same position and is exempt deliberately:
  `autoAllowBashIfSandboxed` means a sandboxed Bash never reaches the callback
  anyway.
- **STILL OPEN: the walker's node budget can be starved.** `NODE_BUDGET` is 512
  nodes, spent and not restored, so once it runs out later siblings are never
  scanned. Measured against `dist`: `{pad:[…600 zeroes…], evil:{file_path:
  "<suite>/x"}}` returns ALLOW. The budget replaced a depth cap that was worse
  (eight `{nest:…}` levels sufficed), and any finite bound has this property —
  an unbounded walk over attacker-shaped input is a denial of service and would
  not terminate on a cyclic object. Narrowing it (charge only CONTAINER nodes, or
  walk breadth-first so shallow keys are never starved by a deep sibling) is the
  real fix and is not done. Padding to 512 nodes is at least conspicuous in a
  transcript in a way a seventh `{nest:…}` was not.
- **Case-folding over-denies on a case-sensitive volume.** A genuinely distinct
  `/x/ACCEPTANCE` would be denied alongside `/x/acceptance`. Deliberate: the
  safe direction for a sealed root.
- **Whether `canUseTool` fires for subagent-originated calls is UNVERIFIED**, and
  the sentence this bullet used to end with — "the Agent-tool guard of §2.4 is
  proven only as a pure function" — was **generous**. Corrected 2026-07-29: that
  guard was not merely unproven as wiring, it was never called, and it has been
  deleted. What remains open is narrower and still open: whether the sealed-root
  scan in `canUseTool` fires for a `Read`/`Grep` issued by a subagent rather than
  the orchestrator. Inferred from the SDK's `agentID` plumbing and corroborated
  by `SDKPermissionDeniedMessage.agent_id`, never observed. It matters less than
  it did, because the policy-tier rule needs no callback and applies to the
  session.

- **The judge seat against a real model.** Its parsing is tested against
  fixtures.
- **`DEFAULT_SEAT_CALL_MAX_TURNS = 8`** is a measured floor from one suite, not
  a bound. `DASHBOARD_SEAT_MAX_TURNS` raises it and is named in the failure text.
- **Every named Codex model id.** The dashboard asserts only `codex-default`
  ("whatever the CLI is configured to use"). Anything in
  `DASHBOARD_CODEX_MODELS` is your assertion, not the dashboard's.

#### UNMEASURED, and not to be laundered into "should hold"

Every item here was reachable by an experiment somebody chose not to run, or by
one this environment cannot run. None of it may be written up as covered.

- **`isolation: "remote"`.** Denied by construction, never measured — it is
  availability-gated and runs off-host, so there was nothing here to observe it
  with. `isolation: "worktree"` IS measured, against a real git-repo fixture so
  a worktree failure could not be mistaken for a hook effect; the denied call
  came back with the hook's verbatim reason rather than a git error.
- **`allowManagedHooksOnly: true` composed with the background / absent-flag /
  selective-policy arms.** Probe E measured the lock for FOREGROUND delegation
  only. Composing the two is an inference — a reasonable one, since the lock
  gates WHETHER programmatic hooks run at all rather than per-tool shape — and
  an inference is what it stays until somebody runs it.
- **Permission modes other than `acceptEdits`** for the hook. Probe A covered
  `default` and `dontAsk` for the *callback*; the hook was measured under
  `acceptEdits`, which is what production sets.
- **Whether `Options.agents.prompt` reaches ANY child.** Both children in probe
  I's DoD-3 arm reported no critical system reminder — including the one with no
  disk file, whose `model` field demonstrably bound. So `oursInForce=false` is
  equally consistent with "the disk definition overrode ours" and "prompt/reminder
  fields are not observable through self-report". **No positive control fired
  for that channel**, which is why the nonce in the reply body — not the
  reminder — is what probe I's verdict rests on.
- **The third start-observable never went positive anywhere.** `startedFor()`
  watches three channels; every subagent in every arm ran with `tool_uses: 0`,
  so the third never fired even for agents that demonstrably started. **Read
  every deny as TWO demonstrated channels going silent, not three.**
- **Whether `AgentDefinition.disallowedTools` does anything.** Probe G2 measured
  a per-agent `disallowedTools: ["mcp__*"]` child at 620 tools, 589 of them
  `mcp__` — identical to an unnarrowed child. Probe G3 then removed that field
  and the narrowed child stayed at 28 tools with zero `mcp__`, so the work is
  being done by the SESSION-level `allowedMcpServers: []` lock. Which of the two
  narrowings does what was not separated by any single run, and the per-agent one
  is now deleted along with the rest of the block.

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
6. **Delegation is allowed, but only to this run's shortlist, and `SendMessage`
   is denied outright.** Corrected 2026-07-29: this item used to say delegation
   was denied outright because the shortlist was empty. It has not been empty
   since `4e05543`. A build may delegate to roughly two dozen agents chosen by
   `shortlistFor(classifySurface(ticket))`; anything else is refused by a
   `PreToolUse` hook with a message naming the permitted agents, and a resume via
   `SendMessage` is refused whoever it is addressed to. If a build reports it
   could not delegate, that is why — not a credential or a network fault. An
   EMPTY shortlist still denies everything, and that remains the fail-closed
   default. See §2.4, and read §0's asymmetry table before treating this as a
   boundary of the same strength as the sealed suite.
7. **Do not paste a secret into a ticket.** The ticket text is sent to the
   provider verbatim, because it is the prompt. On-disk copies are redacted; that
   is a second line of defence, not the first.
8. Expect a **429**. It is a rolling 5-hour window plus a weekly cap, it is a
   normal state, and the run resumes.
9. The first run of a ticket authors and freezes a suite. That costs quota
   before any building happens, and a suite authored under an older prompt is
   not re-authored automatically.
10. **If you are about to add a check, read §6 first.** Seven checks in this
    repo have shipped green over something that did nothing. The pattern is
    cheap to repeat and expensive to find.

---

## 6. The defect this repo keeps shipping — NINE instances, and counting

**New 2026-07-29.** One shape accounts for every false green this project has
produced: **a check that can only observe success.** It is worth the space
because the next author will not be caught by the nine below — they will be
caught by the tenth, and the only defence is knowing the shape.

**Instances 8 and 9 were added the same day the table was written, by an
adversarial pass over the phase that wrote it.** That is the most useful fact in
this section: the shape was not avoided by an author who had just finished
cataloguing it. Knowing the shape is necessary and it is not sufficient — only
running the mutation is.

| # | The check | What it could not see |
|---|---|---|
| 1 | The **16-probe review** of the sealed boundary | It exercised only the vectors its own author designed for, and reported 16/16. A later adversarial pass walked through `Grep{path:<ancestor-of-suite>}` (§0). Whether that exact vector was among the 16 is not recorded; what is recorded is that the review's coverage was measured against its own author's imagination, which is why 16/16 meant nothing. |
| 2 | The **source-text "wiring" test** | It matched regexes against `claude-builder.ts`'s own SOURCE. `canUseTool` deleted, `denyRead` emptied, `allowWrite` widened to `/`, sandbox off — the suite stayed green at 76/74/0 through all four. |
| 3 | **`settings-plumbing.test.ts`** | It constructs its OWN `Options` literal, then asserts that same local variable round-trips into the `--settings` payload. It never calls the builder. It is a test of `JSON.stringify`. **Still in the tree**, still green, and still proves nothing about this codebase. |
| 4 | **Probes C and D**, as the plan wrote them | `positive: true` and `negativeControl: true` shipped as HARDCODED LITERALS, each justified by a comment. Probe C's run declared no non-managed hook at all, so its "user hooks were suppressed" was a constant. Fixed with a real project-tier fixture hook and a byte-identical paired control. |
| 5 | **The probe harness's own exit code** | The gate keyed on `notes.startsWith("INCONCLUSIVE:")` alone, so a plain `FAIL` exited **0**. Run 1 recorded three FAILs — including the probe gating the whole approach — and exited 0. This was the defect the harness was built to prevent, sitting inside the harness. |
| 6 | **The Task 5 token seam** | The per-model fix was reverted at its SOLE production call site and the suite stayed byte-identical at 200/198/0/2 — every assertion lived where the function was called directly. The arithmetic was then lifted into a seam and pinned by five tests; an auditor reverted the CALL SITE and the suite stayed green at 229/227/0/2. **The seam moved the hole one line; it did not close it.** What closes it is driving `build()` with synthetic envelopes and reading the sink. |
| 7 | **A test pinning `AgentBounds.effort`** | It asserted a field that was `null` for all 26 agents, whose only reader was a conditional spread into `AgentDefinition.effort` — a route probe I measured does not bind for any name this run can delegate to. Green forever, over a mechanism that does nothing. Deleted 2026-07-29 with the route. |
| 8 | **The calibration FALSE-PASS test** — `calibration.test.ts`, "no fixture produces a FALSE PASS" | It looped `MUST_FAIL` asserting `outcome === "fail"`. Every `MUST_FAIL` fixture has `expected: "fail"`, which the test ABOVE it already asserts for every fixture — so it was **logically implied and could not fail unless that one already had**. Emptying `MUST_FAIL` (`.slice(0, 0)`, fixtures untouched) left the whole gate **green at 7/7, exit 0**. It survived an adversarial pass of 28 mutations in which 26 went red. Worse: `fixtures.ts` claimed in its header that the false-pass direction was asserted "SEPARATELY and more loudly than overall accuracy" — **a false claim sitting inside the file that documents this very defect.** Closed 2026-07-29: the test now asserts its own derivation and `heldOutPass === false`; re-run under the same mutation it fails ALONE, 1 of 7. |
| 9 | **Two held-out-leak assertions in `run-report.test.ts`** | `assert.doesNotMatch(verdict, HELD_OUT_TITLE)` and the `holdout test T-2` twin, over `verdict.md`. That run never reaches the gate, so the file is the **no-verdict page, which prints no criterion prose at all** — there is nothing for a criterion-borne leak to ride in on. MEASURED: rendering that page from criteria whose statements carried both markers gives 807 bytes containing neither; the same criteria marked scored give 1879 bytes containing both. The `forAssumptions` blanking of `evidenceRequired` is the same shape — passing the field through leaves all ten tests green, because `ApiCriterion` **has no such field**. Milder than the others and said so: the boundary IS proven, by the `assumptions.md` twins (red under a `#recordCriteria` mutation) and by `verdict.test.ts` against `detail`/`evidenceRef`. Relabelled at the assertion site 2026-07-29, not deleted — they go live the day the run reaches the gate. |

Instances 2, 3, 6 and 7 share a sharper sub-shape worth naming on its own: **the
assertion and the production path were never connected.** A test that calls a
function directly can never tell you the loop still calls it. A seam helps read
the code; it does not make the call site load-bearing.

**The rule that came out of this, and it is cheap:** every check must be shown,
in the same run, to be able to observe the OPPOSITE outcome. For a probe, that
is a negative control in the same session. For a boundary, it is REMOVAL —
delete the layer, watch the boundary fail, put it back. Every 2026-07-29 claim
in §0 carries one; the older EXECUTED rows mostly do not, and that is a real
difference in strength between them.

**Nine is a running tally, not a final count.** Two docblocks lag it by
construction, and are left rather than swept so the drift stays visible:
`claude-builder.test.ts:1753` says "six times" (written before instance 7), and
`calibration.test.ts:19` says "five times" of the narrower *skipped-and-reported-
green* sub-shape, which is its own count and not this one. If you find a tenth,
increment it here and say what it could not see.

**And the thing instances 8 and 9 add to the rule:** it is not enough for a check
to be capable of failing in principle. Both of them WERE capable of failing —
just only in the same circumstances that would already have turned a different,
louder check red. **A check whose failure mode is a strict subset of another
check's is not a second check.** The test for it is the one used here: break the
thing THIS check is supposed to see, and confirm it fails ALONE.
