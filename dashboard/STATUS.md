# STATUS — the dashboard, honestly

## SUMMARY — thirty seconds

| Question | Answer, and where the evidence is |
|---|---|
| Does the pipeline run end to end? | **Yes, and it has now done so once for real — §1.0.** `run-2026-07-29T23-28-46-665Z-3d4d1ccb`, a one-page bike-shop site, 1 h 44 m 53 s, every stage ran, none skipped, verdict PASSED WITH NOTES. Before that: GREEN for $0 on 2026-07-27 (24/24 checks, real containers) — §1.3 — plus a live run REPORTED by a module author (§4). |
| Does the grader sort artefacts correctly? | **Once on fixtures, once on a real build.** Run 4, 2026-07-29 pm: 7 of 7 fixtures, no false passes, no false fails, on a suite authored from the ticket alone (§1.4). Authoring is nondeterministic and the SAME harness scored **5/7 with two false fails** that morning. **And in §1.0 the held-out half caught a QUALITY defect the builder did not know about** (an empty booking submission still confirms). Two observations, not a property. |
| Can a build read the held-out tests? | **Anthropic: no** — a CLI **policy-tier** deny rule plus an OS sandbox clause, each proven load-bearing by REMOVAL on 2026-07-29 (§0). **Codex: YES, nothing stops it.** `ThreadOptions` exposes no read restriction; a Codex build can `cat` the held-out suite. |
| Is a `heldOutPass` trustworthy? | On/after 2026-07-29, Anthropic path: policy-enforced — a rule inside a process running as the owner's UID, **not** the bake-off's container. Before **2026-07-28**: **no**, and unrecoverably so — those runs were produced under a boundary with an EXECUTED bypass and there is no tripwire (§0.3). **§1.0's run attempted no sealed read, so no enforcement layer fired in it: its `true` inherits §0's removal proofs rather than re-deriving them.** |
| What will cost money | The first run of a ticket **authors and freezes a suite** before any building (run 1's spec seat: 167,871 output tokens; run 4: 117,462). Every build burns subscription quota — §1.0 burned 1 h 44 m of it in one run. Expect a 429. No dollar figure is ever produced for a subscription run, by construction (§1.8). **And no token figure is recorded either: the spend tables exist and their five writers do not (§1.10).** |
| What must I do before spending? | §5, in order. The three items that actually bite: re-resolve the scorer image digest yourself, build it with `--provenance=false --sbom=false`, and read §0. **The digest moved again on 2026-08-02 — move #5, `sha256:b7a9fd0a…`, and this time it was MEASURED with a shell rather than reported (§1.2).** The 2026-07-30 move was re-resolved that same day and matched. Re-resolve it yourself regardless: any edit under `bakeoff/src` moves it, including one the scorer never executes. |
| I am about to add a check | Read §6 first. **Seventeen** checks in this repo have shipped green over something that did nothing — three of them added on 2026-07-30. |

**THE MOST DANGEROUS THING ABOUT TRUSTING THIS FILE — it has two halves, and the
second one is about the file itself.**

1. Any `heldOutPass` recorded **before 2026-07-28** is not merely weak, it is
   unverifiable after the fact (§0.3).
2. **This file lags its own tree, and the gap is now bigger than the last
   correction said.** The newest count it watched itself is **281**
   (2026-07-29). The 2026-07-30 reorganisation repeated **691** as somebody
   else's number; the 2026-07-30 fix wave then measured **850 tests / 848 pass /
   0 fail / 2 skipped** twice independently (§1.1) — so even the "current"
   baseline handed to every agent in that wave (808/806) was stale before the
   wave ended. **Four whole lanes are still described here mostly by their
   defects** — 2a anti-slop hooks, 2b design lane, 2c image-to-video, 3 canvas —
   and a fifth (4 cron) landed while §3.5 said it had not. §1.10 is the first
   section that measures any of them. A status file that lags its own repo is the
   defect this file exists to prevent, one level up.

---

## How to read this file

Nothing here is aspirational. Every claim carries its evidence level, and there
are **three**, not two:

- **EXECUTED** — someone ran it and observed the result, in the session the row
  is dated to.
- **UNTESTED** — it typechecks and it is reviewed. That is all.
- **REPORTED** — a module author says they exercised it; not re-verified. Their
  word, recorded as their word.

If something is missing from all three, it is not here.

An EXECUTED claim dated **2026-07-29** may carry one extra thing, and where it
does the row says so: **the layer was REMOVED and the boundary was watched
failing.** A layer that is never removed has not been shown to be the one doing
the work — this document has twice recorded a mechanism as load-bearing that
turned out to enforce nothing. Those runs name the artefact under
`dashboard/server/probes/results/` that records them; those artefacts are
read-only.

**Corrections are dated in place and never silently overwritten.** The file was
written 2026-07-27, corrected 2026-07-28 (the held-out boundary), corrected again
2026-07-29 (the Phase 1.1 enforcement pass, which stopped asking the SDK's type
definitions which layers enforce anything and measured it — including by removing
a layer), **reorganised 2026-07-30** by subject rather than by session, and
**extended later on 2026-07-30** with the first end-to-end run (§1.0) and the fix
wave that followed it (§1.10). The reorganisation moved text and deleted no
measurement; so did the extension.

**NEITHER 2026-07-30 PASS HAD A SHELL.** Every verification in the
reorganisation and in the extension is source-reading with `Grep`/`Read`, plus —
new in the extension — reading the run's own committed score record off disk. **No
test was run, no digest re-resolved, no container started, on either pass.** So
§1.1's 850 and §1.2's newest digest row were REPORTED, and the one digest this
file could call measured was the one stamped inside the score record. Claims that
would need a shell to re-check are carried forward as dated records and are
labelled where that matters.

**CORRECTED 2026-08-02 — THAT SHELL-LESS STATE IS NO LONGER TRUE OF §1.2.** A
2026-08-02 pass with a shell rebuilt the scorer image (the spec seat's
manifest-mode rewrite in `bakeoff/src/spec-agent.ts` moved it — move #5) and
**resolved the digest itself, before and after, with `docker image inspect`**. It
also started containers: the rebuilt image was executed directly, and
`npm run bakeoff -- dry-run` ran the whole pipeline for $0 on a stub builder,
**24 checks, 0 failures**, with STAGE 4 printing the new digest as the image the
sealed gate resolved. So §1.2's newest row is MEASURED, the 2026-07-30 row is
retrospectively confirmed, and all three preservation tags are verified on disk.
**§1.1's 850 was NOT re-measured on that pass** — its scope was the image and the
digest chain, and a status file that lets one corrected section imply a
neighbouring one was corrected too is the exact failure this preamble exists to
prevent. `bakeoff`'s own suite was measured, at **117/117**, because the rebuild
had to be shown not to have broken it.

**Where §1's old numbering went** (plans and commit messages cite the old ones;
`§0`, `§2`, `§3`, `§5` and `§6` are unchanged, and two source files point at
`§0` and `§3` by number):

| old | new |
|---|---|
| §1.1 install/build, §1.9 test counts | **§1.1** the trees, the build, the test counts |
| §1.3 scorer image digest | **§1.2** the digest chain (its single home) |
| §1.2 dry run, §1.6 seal audit | **§1.3** the seal, and the dry run |
| §1.10 4A, §1.11 4B run 1, §1.13 4B run 4 | **§1.4** the grader |
| §1.12 (gates part) | **§1.5** the tier-0 gates |
| §1.12 (verdict part) | **§1.6** the verdict page |
| §1.14 visual substance | **§1.7** the visual-substance gate |
| §1.4 bind, §1.5 no-credentials, §1.7 secrets, §1.8 cost | **§1.8** the server, the money, the secrets |
| §1.12 (lanes, open items) | **§1.9** the 2026-07-29 lanes |

Two sections were **added** later on 2026-07-30 rather than renumbered from
anything, so every citation above still resolves: **§1.0** (the end-to-end run,
placed first because it is the most valuable measurement in the file) and
**§1.10** (the fix wave that followed it).

---

## 0. THE TWO BOUNDARIES — read this first

This system enforces two different things by two different mechanisms, and **the
gap between them is the single most useful thing on this page** (§0.4).

The sealed suite lives at `dashboard/acceptance/<ticket>/holdout/*.mjs` —
plaintext, on the same filesystem, two directories above the workspace, owned by
the same user as the build. The dashboard builder runs on the HOST as that same
user. On a single-UID host **there is no filesystem boundary to enforce; there is
only policy inside each CLI.** That is weaker than the bake-off's container,
which never mounts the held-out half at all, and it may not be reported as one.

**I found this open.** Until 2026-07-27 the builder's permission hook denied only
*writes* outside the workspace, and the CLI sandbox's `allowWrite` likewise
restricts only writes. Reading the held-out tests was unrestricted on both
drivers. A builder that reads them can satisfy them without satisfying the
ticket, which makes `heldOutPass` and `falseFinish` meaningless for that run —
and **nothing detects it**. There is no tripwire, no log line, no marker.

**The 2026-07-27 fix was itself incomplete.** Corrected 2026-07-28: until that
date the boundary had an EXECUTED bypass —
`Grep{path:<ancestor-of-suite>, output_mode:"content"}` returned ALLOW and
ripgrep walked down into the sealed store and returned held-out test source.
`decideToolPermission` asked only whether a candidate was INSIDE the suite, never
whether it CONTAINED it. Three holes of the same class were open alongside it:

- `READ_TOOLS` was a tool-name allowlist, so `mcp__*` read tools and
  `ReadMcpResource` returned ALLOW on a sealed path.
- `Grep`/`Glob` with `path` omitted produced no candidate and were allowed; the
  CLI then searched the cwd.
- `results/scorer-out/<runId>/result.json` persisted
  `criterionCoverage[].testRefs` — held-out TEST TITLES — outside the sealed
  store, readable by any later run of the same frozen ticket.

All four are closed and unit-tested with negative controls.

Deliberately **not** fixed by withholding the plaintext during the build window:
any durable on-disk form is equally readable by a same-UID process, and an
in-memory-only form makes a server restart destroy the suite. That trade was
considered and rejected, not overlooked.

### 0.1 What enforces the held-out boundary, per driver

| Layer | Driver | Evidence |
|---|---|---|
| `decideToolPermission` denies the sealed roots — the suite store **and** `results/scorer-out` — for **every tool name**, built-in or `mcp__*` or one that ships next year; by **every value in the input at any depth**, arrays and nested objects included, **and by every object KEY**, except a free-text key's own STRING **on the one tool that key owns it** (`Bash{command}`, `Write{content}`, …) — an unknown tool inherits no exemption at all; judging a glob by the **literal tree it would walk** rather than its raw spelling; in **either direction**, i.e. a candidate inside a sealed root *or* one that contains it; comparing **case-folded canonical forms** with `file://` URIs and percent-encoding decoded first; resolving relatives against the builder's `cwd`, and folding that `cwd` in **unconditionally** for `Grep`/`Glob` | Anthropic | **EXECUTED** — 62 unit tests in `src/builders/claude-builder.test.ts` (62 pass, 0 fail), every widening carrying a negative control that ordinary work is still allowed. **Corrected 2026-07-28 (second pass).** Until that pass this row read "any of 15 path-bearing input keys" — a KEY allowlist, which an adversarial review defeated with `Glob{pattern:"<suite>/**/*"}`, `pattern` not being on the list. The polarity is now inverted: every value is a suspected path unless its key is named free text. **Widened again 2026-07-28 (third pass)** after five more bypasses were probed open against the shipping `dist`: an un-expanded wildcard above the sealed root, a depth-8 nest outrunning the walker's depth cap, a sealed path used as an object KEY, a free-text key pruning its whole SUBTREE, and `command` exempt for every tool rather than for `Bash`. All five now deny; the Agent branch no longer returns before the sealed scan. **Two of the class are still OPEN — see §3.2.** Still a pure-function proof: `decideToolPermission` performs no filesystem access and no `await`, and the caller injects the fs-aware canonicaliser, so symlink resolution is exercised only through that injection. **Corrected 2026-07-29 (Phase 1.1).** Two things this row used to say are now history. The Agent/Task branch inside this function is **deleted** — `canUseTool` is never consulted for the Agent tool, measured under `acceptEdits`, `default` **and** `dontAsk`, the callback returning deny and the subagent starting in every arm (`probes/results/A-default.json`, `A-dontAsk.json`); see §2.4. And this scan is no longer the layer that stops a sealed read: in the live adversarial run the sealed `Read` came back with the POLICY tier's phrase, not this callback's message, so in production it is a backstop for tools the policy rule does not name, not the boundary. Whether it fires for **subagent-originated** calls is still unverified, and now matters less: the tool that spawns subagents never reaches it at all. |
| A programmatic **`PreToolUse` hook** — not `canUseTool` — denies a delegation unless `isolation` is absent, `run_in_background` is explicitly `false`, and `subagent_type` is on this run's shortlist; the same hook denies `SendMessage` outright | Anthropic | **EXECUTED, AND PROVEN LOAD-BEARING BY REMOVAL. Replaced 2026-07-29 (Phase 1.1).** Until that date this row described 8 `canUseTool` tests over a branch **the engine never called**, and claimed the shortlist was empty; both were false — the shortlist has been non-empty since `4e05543`, and the branch was dead in all three permission modes measured. The three conditions are unchanged in substance; they now sit in a slot the engine consults. Live adversarial run 2 (`probes/results/DOD.json`, `runs.DOD-2`): `wordpress-master` was named in the ticket, the model emitted the delegation, the hook saw it and denied it — **no `task_started`, no `SubagentStart`, no agentId minted, no tokens billed** — while shortlisted `code-reviewer` started in the SAME session and billed 14,834 tokens, so the absence is a measurement rather than a model that never delegated. **Removal proof:** make the hook return `{continue:true}` and that run FAILS — `wordpress-master` runs, with its own agentId and 15,871 tokens. Independently reproduced by flipping one bit of the hook's decision in `probes/results/F-AUDIT-MUTATION.json` (`mutationRestoredSpawn: true`; the background child started and billed 15,047). **This is the WEAK half of the boundary — read §0.4 before you rely on it.** |
| `sandbox.filesystem.denyRead` names the sealed roots to the CLI's OS sandbox | Anthropic | **EXECUTED ON BOTH SIDES — corrected 2026-07-29 — AND IT COVERS BASH ONLY.** The BUILDER SIDE was already executed (2026-07-28, third pass): `buildOptions(request, allowUnsandboxed)` is an exported seam and `claude-builder.test.ts` asserts the returned object directly — `denyRead` every sealed root canonicalised, `allowWrite` the workspace alone, `cwd` in the same spelling, `sandbox.enabled` true, `failIfUnavailable` true unless opted out. Emptying `denyRead` or widening `allowWrite` to `/` turns tests red (§1.1). The OS SIDE is now executed too: in live run 1 a sandboxed `cat` of the sealed file came back `Operation not permitted` — the seatbelt's own words, not a permission message (`probes/results/DOD.json`, `runs.DOD-1.observations.sealedCatRecords`). **What makes it a layer of its own is the isolating removal:** with `managedSettings.permissions.deny` EMPTIED, `cat` was still refused. So Bash is covered TWICE, independently. **It does NOT cover the in-process `Read` tool** — Phase 1 measured `denyRead` alone leaving that tool free, and that asymmetry is why the row below exists. `settings-plumbing.test.ts` still proves nothing about any of this: it builds its own `Options` literal and never calls the builder (§6 instance 3). |
| `managedSettings.permissions.deny` names the sealed roots at the CLI's **POLICY** tier, with `allowManagedPermissionRulesOnly` so nothing in user, project or local settings can widen it | Anthropic | **EXECUTED, AND PROVEN LOAD-BEARING BY REMOVAL. New 2026-07-29 (Phase 1.1) — this is the layer the in-process `Read` tool has, and it is the ONLY one it has.** Probe B, three consecutive live runs under strengthened gates, then live adversarial run 1: `Read` of the sealed file returned `File is in a directory that is denied by your permission settings.`, the sentinel appeared nowhere, the read WAS attempted, and non-sealed files stayed readable by both `Read` and `cat` in the same run, so the denial is scoped rather than a blanket break (`probes/results/B.json`, `probes/results/history/B-2026-07-28T19-*.json`, `probes/results/DOD.json` `runs.DOD-1`). **Removal proof:** empty the deny array and run 1 FAILS with the sentinel leaking into the transcript. No callback and no hook is involved — precedence is `user < project < local < flag < policy` and this is the policy tier, and the sealed `Read` never reaches the `PreToolUse` hook at all because this rule stops it first. **Credit the PAIR, not the deny rule alone:** the rule and `allowManagedPermissionRulesOnly` were never separated in any run. |
| anything | **OpenAI / Codex** | **NONE.** `ThreadOptions` exposes no read restriction; `sandboxMode: "workspace-write"` limits writes only, and `additionalDirectories` is an *allow* list. A Codex build can `cat` the held-out suite. |

### 0.2 Three facts you should not have to discover

- `autoAllowBashIfSandboxed: true` means a sandboxed Bash command **never
  reaches** the permission callback. `cat`/`grep` are covered by the OS layer,
  which on Anthropic is no longer unverified — **corrected 2026-07-29**: it was
  measured refusing a sealed `cat` with `Operation not permitted`, and measured
  still refusing it with the policy-tier rule emptied. On **Codex** that layer is
  absent, and no other layer replaces it.
- **The count of layers DIFFERS PER TOOL, and one rule does not cover both.**
  `sdk.d.ts:6194` says `Read(...)` deny rules merge into the sandbox's
  `denyRead`, and until 2026-07-29 this document leaned on that to claim one rule
  covered the in-process `Read` tool and sandboxed Bash together. **The merge
  claim is withdrawn as an attribution.** With `permissions.deny` emptied the
  sandboxed `cat` was still refused, so the two are INDEPENDENT layers, and the
  earlier run — which had both set — could never have told "the rule merged" from
  "`denyRead` bound on its own". The honest count: sandboxed Bash has **two**
  layers, the in-process `Read` tool has **one**. The two refusals are
  distinguishable by their text, and that is the discriminator worth keeping:
  `File is in a directory that is denied by your permission settings.` is the
  policy tier; `Operation not permitted` is the seatbelt.
- Whether the policy rule — spelled `Read(//<root>/**)` — also binds
  `Glob`/`Grep`/`mcp__*` is **UNMEASURED**. Every live run exercised `Read` and
  `Bash cat` only. Those tools are covered by the callback's sealed scan; the MCP
  surface is separately removed outright (`allowedMcpServers: []` plus
  `allowManagedMcpServersOnly`, measured at 0 servers against 13 unnarrowed,
  `probes/results/mcp.json`).

### 0.3 What a `heldOutPass` means, by date

- **On/after 2026-07-29, Anthropic path:** a policy-enforced result — a rule at
  the CLI's policy tier plus an OS sandbox clause. Stronger than 2026-07-28,
  when the same sentence had to be written about a permission callback. Still
  policy inside a process running as the owner's own UID: **not** the bake-off's
  container.
- **Codex path, any date:** unenforced. See §0.1's last row.
- **Before 2026-07-28:** produced under a boundary with an executed bypass.
  There is no tripwire, so **it cannot be determined retrospectively whether any
  given run walked through it. Treat those results as unverified** — and there is
  no way to recover the answer after the fact.
- **The first real run (§1.0, 2026-07-30) ATTEMPTED NO SEALED READ, so no layer
  above fired in it.** Added here because §0.3 is where somebody will come to
  read that run's `heldOutPass: true`, and the honest reading is: enforcement is
  **inherited from the removal proofs in §0.1, not re-derived by that run.** The
  run neither strengthens nor weakens this section. A build that never tries the
  door tells you nothing about the lock.

### 0.4 The two boundaries are NOT the same strength, and that is deliberate

**New 2026-07-29 (Phase 1.1).**

| | Sealed-suite integrity | Delegation shortlist |
|---|---|---|
| Enforced by | `managedSettings.permissions.deny` + `allowManagedPermissionRulesOnly` — the CLI's **policy** tier — and `sandbox.filesystem.denyRead` | ONE programmatic `PreToolUse` hook, with no `matcher`. Nothing else. |
| Callback involved | none | the whole of it |
| Can the owner's own settings widen it | **no** — precedence is `user < project < local < flag < policy` | not applicable; there is no settings expression of `subagent_type` at all |
| Proven load-bearing by | emptying `permissions.deny` → run 1 FAILS, sentinel leaks. Emptying it while keeping `denyRead` → `cat` still refused, `Read` not | making the hook return `{continue:true}` → run 2 FAILS, `wordpress-master` runs with its own agentId and 15,871 tokens |
| If it fails | `heldOutPass` and `falseFinish` are meaningless for that run, and **nothing detects it** | a wasted run, wrong-tier spend, a subagent nobody shortlisted |

The strong layer carries the property that must not fail. The weak layer carries
the property whose failure costs a run. What Phase 1 got wrong was having
integrity depend on the weak layer — and the weak layer, at that point, was a
callback that was never consulted at all.

**Why the shortlist cannot be moved to the strong tier:** no engine mechanism
expresses `subagent_type`. `disallowedTools` is name-granular,
`permissions.deny` is path-granular, and `subagent_type` is a free string in the
SDK's schema. `Options.agents` does not bind for these names either (§2.4). The
hook is not the preferred instrument; it is the only one.

**THE LATENT RISK, recorded because it is one plugin install away.** A
`PreToolUse` hook that returns `permissionDecision: "allow"` pre-empts
`canUseTool` entirely — `sdk.d.ts:4166`, verbatim: *"PreToolUse hook denies
bypass canUseTool and are not covered here"* — and that bypass was proven live on
a fixture hook, with the sealed suite's contents coming back in the transcript.
Builds therefore set `managedSettings.allowManagedHooksOnly: true`. Probe C
measured what that lock does and does not do: it suppressed a project-tier hook
**and** a flag-tier hook (more than `sdk.d.ts:5418` names) while our own
programmatic `Options.hooks` callback still fired under it
(`probes/results/C.json`).

**The cost, recorded rather than glossed: that lock also disables the owner's
`secret-guard.sh`**, which is protective — it hard-blocks writing a live Stripe
secret key into a file or a command. A build writes only inside its own workspace
and is handed no secrets, so the exposure is small. It is not zero, and it is a
real thing traded away for a bypass that is currently latent: every hook
installed in `~/.claude/` today emits only `"deny"`.

**What is NOT measured here:** whether a foreign `allow`-returning hook would
pre-empt OUR deny. The lock removes the case rather than answering it. If the
lock is ever turned off, that question is open again and unanswered.

---

## 1. MEASUREMENTS, BY SUBJECT

Dated. A measurement without its date is worthless in this file, because three
of its held-constant variables have moved.

**Read §1.0 first.** Everything else in §1 measures one seam at a time; §1.0 is
the only measurement of all of them at once.

### 1.0 THE END-TO-END RUN — `run-2026-07-29T23-28-46-665Z-3d4d1ccb` (2026-07-30)

**The most valuable measurement in this file.** A one-page bike-shop site, driven
through the whole dashboard path — ticket → spec → build (two segments) → sealed
gate → judge — in **1 h 44 m 53 s**. **Every stage ran; none was skipped.**
Verdict: **PASSED WITH NOTES**.

**What is primary source here, and what is not.** This pass had no shell. Every
line marked EXECUTED below was read directly out of the run's own committed score
record, `dashboard/results/scores/run-2026-07-29T23-28-46-665Z-3d4d1ccb.json`
(with its `.container.json` sibling). Everything else is the run's report, i.e.
REPORTED, and is labelled.

```
EXECUTED — read off the score record, 2026-07-30
heldOutPass            true        falseFinish  false      agentDeclaredDone true
suiteExecution         exitCode 1  21 tests     20 passed  1 failed   8708 ms
scoredAt               2026-07-30T01:12:52.732Z
scorerImageDigest      sha256:c98bad3a762b8fc026bbeb8edc85ea8951cf78ea2bab70eb8d28e992f7826b20
acceptanceSuiteSha256  21c30afddba344780a4e9e2fd77c5c5ecca11043222f6ee41271e28f4dcc2060
ticketId               t-621a2808720d755e        protectedPathViolations  []
```

#### What FAILED — and it is the best news in the run

**REQ-013, QUALITY: *"an empty booking submission produces no confirmation"* —
`passed: false`.** Detail, verbatim: `1 of 1 asserting test(s) failed:
holdout/coglane-presentation.spec.mjs › [REQ-013] T-14 an empty booking
submission produces no confirmation [unexpected]`.

**The held-out half caught a defect the builder did not know about**: the booking
form confirms a submission with nothing in it. The run's report reproduced it with
a before/after control. This is the first time on this path that the sealed half
told the owner something the visible half had not — §1.4 asked "does the grader
discriminate?" of fixtures, and this answers it once on a real build. **EXECUTED**
(the criterion row is in the record; the before/after control is REPORTED).

#### Three more things in that record are worth as much as the headline

- **`GATE:suite-green` PASSED while `suiteExecution.exitCode` was `1` and
  `testsFailed` was `1`.** A QUALITY-only failure did not gate the run. This is
  the **first live, non-fixture exercise of the 2026-07-29-am QUALITY-gate fix**
  (§1.2's `bcd01771…` row); until now it had only ever run against calibration
  fixtures. EXECUTED.
- **`PASSED WITH NOTES` on a real build.** §1.6 records `pass_with_notes` as
  *structurally unreachable* before that fix and measured only on fixtures after
  it. It is now a live outcome. EXECUTED (verdict REPORTED, the QUALITY-only
  failure that produces it is in the record).
- **`GATE:build`'s corroboration works in the field.** Its detail reads `NOT
  APPLICABLE: the frozen manifest declares no build step, and the artefact
  agrees: searched for a package.json declaring a non-empty "scripts.build"; a
  bundler or framework config …; a compiled-only source file … across 16 walked
  file(s) and found none.` That is backlog #35 (§1.5) behaving as designed on an
  artefact nobody staged for it. EXECUTED.

#### Three unknowns this run settles, and one it does not

1. **The two build segments resumed ONE provider session.** Established four
   independent ways, including token totals that **sum exactly rather than max** —
   a check that could have observed the opposite outcome. §3.1 listed resume as
   UNTESTED; that bullet is corrected in place. **REPORTED** — this pass read no
   artefact for it.
2. **The held-out half discriminates on a real build.** REQ-013, above.
   **EXECUTED.**
3. **`npm run bakeoff -- dry-run` is GREEN against an installed scorer image** —
   the first dry run recorded since 2026-07-27. **REPORTED. And it does not close
   the checklist item it was supposed to close** — next paragraph.

**THE CORRECTION THE RUN'S OWN DATES FORCE, and it is against the summary that
reported the run to this file.** That summary listed the dry run as settling both
trees' "no dry run against the installed image" gap. It does not. The score record
is stamped `scoredAt 2026-07-30T01:12:52Z` and `scorerImageDigest c98bad3a…`; the
fix wave **rebuilt the scorer image later the same day** (§1.2's newest row). So
the dry run is green against `c98bad3a…`, which is already superseded, and **§5
item 4 and `bakeoff/STATUS.md` §8 item 6 stay OPEN — for a new reason that is now
written down** rather than for the old reason that no dry run existed at all.
Recorded this way deliberately: accepting "settled" here would be §6's defect
committed at the document level.

#### Two limits the run was honest about — neither may be lost

- **No sealed read was attempted, so NO ENFORCEMENT LAYER FIRED.** Nothing in
  this run exercises §0. Its `heldOutPass: true` is worth exactly what §0.1's
  removal proofs are worth and not one line more: enforcement here is
  **inherited, not re-derived.** Pointer added at §0.3 so nobody reads the `true`
  without this sentence.
- **The visible acceptance half CANNOT BE EXECUTED on the dashboard path.** The
  OS sandbox refuses `listen` on 127.0.0.1, so the builder cannot serve its own
  artefact and therefore cannot run the visible suite it was handed. On this path
  the visible half is a **read-only signal** — the builder can read those tests
  and reason from them, and cannot run them. That is strictly weaker than the
  bake-off path, where the container runs both halves, and it means **"the visible
  suite was green" is a sentence nobody on this path can say.** Carried into
  §1.9's open table. REPORTED.

#### What the run cost, and what the record says about that

No dollar figure, by construction (§1.8). **And no token figure either: the run
record carries no spend at all.** The tables, the per-vendor arithmetic, the
`spend.md` page and the pricing footer all landed in the fix wave — the five
`recordSeatSpend` / `recordMeteredSpend` call sites did not (§1.10). So the only
token accounting for a 1 h 44 m run lives in an agent's report, not in the
artefact the owner would read. It fails honestly rather than as a zero — the empty
branch refuses to render a total — but it fails.

### 1.1 The trees, the build, and the test counts

**2026-07-27 — both trees install, build and typecheck.**

```
bakeoff              npx tsc --noEmit  -> exit 0
dashboard/server     npx tsc --noEmit  -> exit 0
dashboard (UI)       npx tsc --noEmit  -> exit 0    next build -> green
```

No `any`, no `@ts-ignore`, no non-null assertion was added to reach this.

**`dashboard/server` imports `bakeoff/dist/*.js`, not `bakeoff/src`.** `bakeoff`
is a `file:` dependency symlinked into `server/node_modules`. So every shared
property is a property of *compiled output*, and `tsc --noEmit` proves nothing
about whether `dist/` is current. Checked directly on 2026-07-27: no `src/**.ts`
was newer than `dist/`, and a fresh `npm run build` produced a **byte-identical**
`dist/` (SHA-256 over every emitted `.js`, before and after). The server had
**not** been running against stale code.

#### The test-count chronology

Each line was true when written. None is the current count.

```
2026-07-27  bakeoff        npm test                     32 pass, 0 fail
                           test/tickets.smoke.mjs       45 assertions
                           test/spec-agent.smoke.mjs    107 assertions
                           test/ledger.smoke.mjs        104 assertions
                           test/subscription.smoke.mjs  146 assertions (live layer 2 skipped)
                           test/scorer-modes.e2e.mjs    29/29, real containers
                           dry-run                      24/24
            dashboard/server  npm test   41 pass, 0 fail, 2 skipped (quota)
            dashboard (UI)    next build green
2026-07-28  after the held-out pass added 17 tests      60 tests, 58 pass, 0 fail, 2 skipped
                           claude-builder.test.js       26 pass
2026-07-28  after the second boundary pass (+16)        76 tests, 74 pass, 0 fail, 2 skipped
                           claude-builder.test.js       42 pass
2026-07-28  after the wiring seam and four residuals (+20)  96 tests, 94 pass, 0 fail, 2 skipped
                           claude-builder.test.js       62 pass
2026-07-29  Phase 1.1: npm run clean && npm test        240 tests, 238 pass, 0 fail, 2 skipped
2026-07-29  Phase 2e:   npm run clean && npm test       281 tests, 279 pass, 0 fail, 2 skipped
2026-07-30  the fix wave, dashboard/server              850 tests, 848 pass, 0 fail, 2 skipped
            bakeoff, node --test over dist              112 / 112
            client, playwright --project=unit            13 / 13
```

**The 2026-07-30 line is REPORTED, not measured here — and it is reported by two
agents who measured independently** (the fourth fix lane, and the verification
agent who then re-ran every mutation and re-measured after restoring each one).
The 2 skips are still the same `DASHBOARD_LIVE_SMOKE` quota gates. **The wave also
shows how fast this number rots:** the baseline handed to every agent in it was
**808/806/0/2**, and three lanes independently reported that figure stale before
the wave ended — one lane opened on a tree already at 811/806 with **3 red** from
siblings' in-flight edits, which is what a shared working tree looks like from
inside. Any single lane's delta is therefore not attributable: the +42 from 808 is
four lanes plus whoever else was editing.

The 2026-07-28 "+20" was **21 written**, net of the source-grepping "wiring"
test deleted for asserting on text rather than behaviour (§6 instance 2). The 2
skips are the same quota-gated live-smoke tests throughout
(`DASHBOARD_LIVE_SMOKE`), verified BY NAME rather than by count: "the spec seat
runs over the subscription…" and "a SeatCallRequest's jsonSchema is APPLIED…".
`npm run clean` first, always: a stale `dist/**/*.test.js` inflates the count.

**The 240 is the only line where the count goes DOWN, and that is the correct
outcome rather than a regression.** Arithmetic: 245 (baseline) **+1** delivery
test for the report contract **−6** shape tests deleted **+1** absence test
**−1** test for a field that no longer exists = 240. The six deleted tests
asserted the SHAPE of `Options.agents` per-agent definitions — a mechanism since
measured **unreachable** (§2.4) — and one more pinned an `effort` field whose
only reader was that same dead spread. Deleting a green test that asserts a dead
mechanism is the point of the pass, not damage from it; the replacement absence
test also re-asserts the hook, so it cannot go green by the guard vanishing.

**The 281 was itself a correction, and the wrong number is named rather than
quietly overwritten.** The Phase 2e line originally read `271 tests, 269 pass`.
That was true when Task 4A closed and WRONG by the time the phase did: Task 5
added ten tests in `run-report.test.ts` afterwards and nobody re-ran the line the
DoD points at. Arithmetic: **240 +41 new = 281**, where 41 = spec-assumptions 9,
visual-criteria 5, verdict 10, calibration 7, run-report 10. (240 is the
post-Phase-1.1 test count; 238 is that run's PASS count.)

**NOT MEASURED HERE: the current baseline. Superseded 2026-07-30 — the 691 below
is now two baselines out of date** (691 → 808 → 850), and it is left in place
because the reasoning attached to it is what matters: every number in this
subsection was somebody else's measurement at the moment it was written down. Two
independent statements in the
repo put it at **691 tests / 689 pass / 0 fail / 2 skipped** — the build
instructions given to every agent in this wave, and
`docs/superpowers/plans/2026-07-29-phase-4-cron.md:98-101`, which adds *"Siblings
are adding tests; re-measure rather than trusting that number"* and names the 2
skips as `subscription-caller.live.test.ts` behind `DASHBOARD_LIVE_SMOKE=1` — the
same file holding the two test names verified above. **The 2026-07-30 pass had no
shell and did not run `npm test`, so 691 is repeated here as somebody else's
number, not measured.** The one corroborating fact that *was* verified:
`dashboard/server/src/**/*.test.ts` globs **47 test files**. Treat 691 as the
number to re-measure and 281 as the last one this file watched.

#### The wiring mutations, re-applied one at a time (2026-07-28)

Phase 0.1 shipped a "wiring" test that matched regexes against
`claude-builder.ts`'s SOURCE TEXT. Five mutations that DISCONNECT the boundary
entirely each left that suite green at 76/74/0 (§6 instance 2). All five were
re-applied to source against the seam introduced by the third pass — `dist`
rebuilt each time, `npm test` run each time — and each now turns tests red:

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

**This is Phase 0.2 history as of 2026-07-29** and is kept because the mutations
still bind the sealed-root wiring. The `ALLOWED_AGENTS` detail no longer
describes the tree: the Agent branch those tests covered is deleted, and the
shortlist it consulted moved to a `PreToolUse` hook (§2.4). **Whether all five
still kill after Phase 1.1's edits to `buildOptions` has NOT been re-measured** —
a green suite says nothing about that, which is the whole lesson of §6.

#### The re-attack against `dist` (Phase 0.2 — 2026-07-28)

A scratch probe (not committed — it is an attack script, not a fixture) fired
every bypass from Phase 0, 0.1 and 0.2 at the **shipping `dist/`**, plus every
negative control: **140 checks, 0 failures.** Each attack had to DENY *and* carry
the sealed-suite message, so an Agent call refused for a different reason could
not pass for the wrong one. The negative controls include
`Glob{pattern:"**/*.ts"}`, `Bash{command:"ls <suite>"}`,
`Write{content:"see <suite>"}`, `Grep{pattern:"TODO"}`, a clean shortlisted
`Agent` call, `/tmp/dash/acceptance-notes`, and an ordinary `MultiEdit`.
**Dated, not current:** the Agent-call rows exercised a branch that no longer
exists, and the phrasing they were recorded under ("refused by the empty
shortlist") was already wrong when written — the shortlist has been non-empty
since `4e05543`. The sealed-path rows are unaffected. **Four inputs still
returned ALLOW that nobody chose** — recorded in §3.2, not hidden here.

### 1.2 The scorer image digest — the dated chain, and its ONLY home

**THE DIGEST IS HELD-CONSTANT VARIABLE 3. Score records taken either side of a
move are not comparable with each other, and nothing in the record announces
that on its own. An entry is never overwritten when the digest moves.**
`bakeoff/STATUS.md` keeps its own dated values in place and points here; this
table is the chain.

Every value below was resolved with `docker image inspect bakeoff-scorer:1
--format '{{.Id}}'` at the stated date. **Re-resolve it yourself before a
campaign — never transcribe one of these.** A transcribed digest certifies
nothing: it proves only that somebody copied a string.

| date | digest | what moved it |
|---|---|---|
| before 2026-07-27 | `sha256:c7f5e1a4…` | superseded by the two D1/D2 fixes |
| 2026-07-27 | `sha256:1c06aa11c425044af4a5dc8cd0b3ff6b7f78e185fd54204c0a8fd810d8074353` | the `node --test` second pass and the D2 fix |
| 2026-07-29 (am) | `sha256:bcd017714ba73e07d3222fb83dda350081edba88e60abf607d469641a2974874` | the QUALITY-gate fix in `scorer-container.ts` / `scorer-protocol.ts` — `GATE:suite-green` now ignores a failing test whose title names only QUALITY criteria. **First exercised on a REAL build 2026-07-30 (§1.0): the gate passed while the suite exited 1 with one failed QUALITY test.** Until then it had only run against fixtures. |
| 2026-07-29 (pm) | `sha256:c98bad3a762b8fc026bbeb8edc85ea8951cf78ea2bab70eb8d28e992f7826b20` | the three tier-0 fixes: `.html` in the stub scan, two more reward-hack families, and `GATE:build` reporting `unknown` rather than passing when a manifest declares no build step the artefact contradicts. **This was the only value in the chain this file could call MEASURED rather than transcribed: it is stamped inside §1.0's score record, which was read off disk on 2026-07-30.** Corrected 2026-08-02: no longer the only one — the 2026-08-02 row was resolved with a shell by the pass that wrote it, and this image was separately re-inspected that day as `bakeoff-scorer:pre-readmech` = `c98bad3a762b8fc026bbeb8edc85ea8951cf78ea2bab70eb8d28e992f7826b20`, which is the first time its preservation tag was verified rather than asserted. |
| **2026-07-30** | **`sha256:fae56a4e1374ee215bb1d23c20b2c55519f8c071bdb6c283d77ef29288e33770`** — **REPORTED, NOT RE-RESOLVED HERE** — **CONFIRMED 2026-08-02** | **move #4.** The fix wave edited `bakeoff/src/tier0.ts` (the `GATE:boot` docblock and `problem` string that overstated what the static arm can see — §6 instance 16) and added `tier0.test.ts`; stage 1 compiles `src/`, so the image moved. Built `--platform linux/arm64 --provenance=false --sbom=false`; the value is what `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` printed for the lane that built it, i.e. the same field a `ScoreRecord` records. Previous image preserved as **`bakeoff-scorer:pre-readmech`** = `c98bad3a…`. **The 2026-08-02 pass had a shell and resolved `bakeoff-scorer:1` to exactly this value BEFORE rebuilding — so this row is no longer a report; it was independently confirmed, two days late, by the pass that superseded it.** |
| **2026-08-02** | **`sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8`** — **MEASURED HERE, NOT TRANSCRIBED** | **move #5.** The spec seat rewrote the manifest-mode rule in `bakeoff/src/spec-agent.ts` — the STATIC/SERVER discriminator stopped keying on site-type NOUNS (it named "a portfolio" and advertised STATIC as "THE COMMON CASE") and now keys on the BEHAVIOUR the ticket asks for, so a ticket that says "portfolio" *and* asks for an API is SERVER and its backend is actually booted. `spec-agent.test.ts` changed with it. **The scorer never executes `spec-agent.js`, but stage 1 compiles all of `src/`, so the image moved anyway** — that is this row's whole reason to exist. Built `docker build -f docker/scorer.Dockerfile -t bakeoff-scorer:1 --platform linux/arm64 --provenance=false --sbom=false .` from `bakeoff/` — `docker/README.md` §1's canonical form (invoked with absolute paths for `-f` and the context root, which is the same Dockerfile and the same context, and keeps `docker/scorer.Dockerfile.dockerignore` in effect). Previous image preserved as **`bakeoff-scorer:pre-specmode`** = `fae56a4e…`, tagged BEFORE the build and re-inspected after it to prove the tag did not follow the rebuild. |
| **UNRECORDED — three moves between 2026-08-02 and 2026-08-16** | `pre-lane4` = `bcd01771…` · `pre-never-stop` = `83b80ef5…` · `pre-repair-2026-08-10` = `ec79e1ef…` — **all three MEASURED 2026-08-16** with `docker image inspect` | **THIS CHAIN LAGGED ITS OWN TREE AND THIS ROW SAYS SO.** Three preservation tags exist that no row above accounts for. Their digests are resolved here; **which source change caused each is NOT known to this file and is not guessed.** `pre-lane4` resolves to the same value as the 2026-07-29 (am) row (`bcd01771…`), so that tag was applied to an image the chain already names. A digest chain with unrecorded links is exactly the failure the chain exists to prevent, one level up. |
| **2026-08-16** | **`sha256:8ff94951f65965d647bbcd907368cae1c20dd78e3c3b2ef42444642e4fef64f7`** — **MEASURED HERE**, resolved with `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` before and after the retag | **move #6.** `docker/node-test-reporter.mjs` now emits a structured `failure{name,message,stack,operator,code,expected,actual}` on `test:fail`, unwrapping node's `ERR_TEST_FAILURE` wrapper to reach the real error on `.cause`; `scorer-protocol.ts` gained `TestFailure`, `SuiteRunnerName`, `MAX_PERSISTED_FAILURES = 60`, `SuiteExecutionRaw.failures` and `parseTestFailures`; `readParsedFailure`/`criterionToken`/`collectFailures` were lifted out of `scorer-container.ts` (which exports nothing and throws on import outside the container, so they were untestable there). **WHY IT WAS NEEDED:** a `fail` carried no reason anywhere a machine could read, so runs `e1c15359` and `047f9872` each lost four FUNCTIONAL criteria to one cause that took a hand-written regex over a stdout blob to find. **NOT A SCORING INPUT** — `computeHeldOutPass` and `attributeCriteria` do not read it. Previous image preserved as **`bakeoff-scorer:pre-testfailure`** = `027bc2e2…`, tagged BEFORE the promotion and re-inspected after it. Verified end to end: the archived `047f9872` artefact re-scored in a real `--network=none` container reproduces 47/40/7 exactly and now carries all seven reasons, the first reading `npm start did not answer /api/health … npm error Missing script: "start"`. |

**THE NEWEST ROW IS MEASURED — THE FIRST ONE IN THIS CHAIN THAT WAS RESOLVED BY
THE PASS THAT WROTE IT.** Corrected 2026-08-02: the paragraph that stood here said
"the newest row is a report", and that sentence was true of the 2026-07-30 row and
is false of the 2026-08-02 one. Both claims are kept, each attached to its own row.

- **The 2026-07-30 row (`fae56a4e…`) was a report when written.** Neither
  2026-07-30 pass had a shell, so it was asserted by the lane that built the image
  and agreed with by the verification agent who re-ran that lane's mutations —
  **agreement between two agents, not independent resolution.** It is now
  confirmed anyway, by accident of sequence: the 2026-08-02 pass ran
  `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` **before** rebuilding
  and got `fae56a4e1374ee215bb1d23c20b2c55519f8c071bdb6c283d77ef29288e33770`
  character for character. A report that later survives an independent resolution
  is still worth labelling as what it was when written.
- **The 2026-08-02 row (`b7a9fd0a…`) is measured.** It was resolved with
  `docker image inspect`, not read out of build output — BuildKit printed
  `exporting manifest sha256:b7a9fd0a…` too, but a number scraped from a build log
  is a transcription and this section forbids those. **Three further things were
  measured rather than assumed:** (1) the digest MOVED — `b7a9fd0a…` ≠
  `fae56a4e…`, which is the check that discriminates, because a rebuild that
  reproduced the old digest would have meant the edit never entered the context;
  (2) the rebuilt image actually carries the new rule — `node -e` inside it read
  `/opt/bakeoff-scorer/dist/spec-agent.js` and found `DECIDE ON THE BEHAVIOUR`
  present and the old `THIS IS THE COMMON CASE` **absent**, a two-sided check, so
  stage 1 demonstrably compiled the edited source and not a cached copy; (3) the
  sealed gate resolved this exact digest at run time — STAGE 4 of the dry run
  printed `sha256:b7a9fd0a…` under "the gate resolves the scorer image by CONTENT
  DIGEST" and then scored a run through it.

**THE "grep RETURNS NOTHING" CLAIM WAS TRUE WHEN WRITTEN AND IS NOT TRUE NOW —
corrected 2026-08-02 by running it.** The paragraph here said `grep` for
`fae56a4e` across both trees returns **nothing**. With `/usr/bin/grep -rl`
(excluding `node_modules` and `.git`) it returns **32 files**; `b7a9fd0a` returns
**12**. What matters is that none of them is a pin:

| | `fae56a4e…` | `b7a9fd0a…` |
|---|---|---|
| score records under `dashboard/results/` | 16 — 7 calibration-4a fixtures × (`*.json` + `*.container.json`), plus 2 for run `…052c6e02` | 0 |
| dry-run score artefacts under `bakeoff/dry-run/` | 0 | 3 — `scores/*.json`, `*.container.json`, `runs/…/score.jsonl` |
| `dashboard/data/runs.db` | 1 | 0 |
| turbopack dev-cache blobs under `dashboard/.next*` | 11 | 8 |
| prose (`bakeoff/STATUS.md`, `docs/HANDOVER.md`, `docs/STATE-2026-08-02…md`, this file) | 4 | 1 (this file) |
| **`.ts` / `.mjs` source** | **0** | **0** |

**The substance of the original claim survives, and it is the only part that ever
mattered: zero source files pin a digest.** Every call site uses the moving tag
`bakeoff-scorer:1`, and `SealedScorerGate` re-resolves before every run and throws
on drift. Everything else in that table is a digest being **recorded** — a
`ScoreRecord` stamping the image that scored it, which is the mechanism working as
designed — or a derived cache.

**A TRAP THAT COST THIS PARAGRAPH TWO WRONG COUNTS, WORTH MORE THAN THE COUNTS.**
The `grep` on this machine's interactive PATH is a shell function wrapping
**`ugrep --ignore-files`**, which honours `.gitignore`. `bakeoff/dry-run/` is
ignored (`bakeoff/.gitignore:45`) and so is `dashboard/results/`
(`.gitignore:26`) — **precisely the two directories where score records live.** So
the obvious command silently reports zero hits in the only places a digest is ever
stamped, and a first pass here concluded `b7a9fd0a` "appears nowhere but this
file" while three dry-run score artefacts on disk contained it. **If you audit a
digest, use `/usr/bin/grep` explicitly.** An ignore-respecting search over an
ignored results tree is a check that can only observe what it is permitted to see,
which is this repo's signature defect wearing a different hat (§6).

**Re-resolve the digest yourself anyway.** A grep result is a claim with a
timestamp: the previous one rotted in three days, and the replacement rotted
inside a single session — `b7a9fd0a`'s count went from 1 to 12 the moment the dry
run wrote its score records. That is the argument for the rule at the top of this
section, not against it.

**WHAT MOVE #5 COSTS.** Everything stamped `fae56a4e…` is now on the far side of a
move: the **seven calibration-4a fixture scores** (`blank-page`, `broken-build`,
`correct-portfolio`, `missing-section`, `reward-hacked`, `stock-motion-only`,
`stub-markers`) and the **2026-07-30 end-to-end run `…052c6e02`**, including its
failed `GATE:boot`. Score-record-to-score-record comparison across that boundary is
what is lost. What survives is that **`bakeoff-scorer:pre-specmode` is on disk**,
so any of those is reproducible with
`BAKEOFF_SCORER_IMAGE=bakeoff-scorer:pre-specmode`. In this particular case the
behavioural risk is unusually low — the only source change was to
`spec-agent.ts`, which **the scorer entrypoint never imports** — but "the change
was harmless" is a claim about intent, and the digest is held-constant variable 3
regardless of which file moved it. The row exists because the digest moved, not
because the scorer changed.

**`--provenance=false --sbom=false` STILL PINS THE DIGEST — re-measured 2026-08-02,
not carried forward.** A second build from an identical context produced
`sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8` again,
byte for byte. That property was last measured on 2026-07-29 against `c98bad3a…`;
it now holds on a second image, two base-image-identical builds apart. The scratch
tag used for the check was removed; it pointed at the same image id as
`bakeoff-scorer:1`, so untagging deleted nothing.

**WHAT MOVE #4 COSTS, and it is not abstract.** §1.0's run — the only end-to-end
measurement in this file — was scored under `c98bad3a…`, and so was its green dry
run. Both now sit on the far side of a move. Every `fixtures.ts` row that reads
"RE-MEASURED 2026-07-29 (image `sha256:c98bad3a…`)" is in the same position. The
comparison that is *lost* is score-record-to-score-record across the boundary; what
survives is that `bakeoff-scorer:pre-readmech` is still on disk, so any before/after
pair behind the tier0 wording change is reproducible with
`BAKEOFF_SCORER_IMAGE=bakeoff-scorer:pre-readmech`.

**THE PREVIOUS IMAGE IS STILL ON DISK as `bakeoff-scorer:pre-lane4`**, verified on
2026-07-29 to resolve to `sha256:bcd0177…974874`. That is what makes the
2026-07-29 (pm) row auditable rather than merely asserted: every before/after
pair behind those three fixes is reproducible with
`BAKEOFF_SCORER_IMAGE=bakeoff-scorer:pre-lane4`. Do not delete it while any
measurement in §1.4 or §1.5 is still being compared. A second build from an
identical context reproduced `c98bad3a…` exactly, so `--provenance=false
--sbom=false` does pin the digest as §5 claims. **Neither the current digest nor
`pre-lane4`'s presence was re-checked on 2026-07-30 — that pass had no shell.**

**RE-CHECKED 2026-08-02, WITH A SHELL — all three preserved images are on disk and
all three resolve to the values this table records.** `docker image inspect
--format '{{.Id}}'` on each:

| tag | resolves to | the row it makes auditable |
|---|---|---|
| `bakeoff-scorer:pre-lane4` | `sha256:bcd017714ba73e07d3222fb83dda350081edba88e60abf607d469641a2974874` | 2026-07-29 (am) |
| `bakeoff-scorer:pre-readmech` | `sha256:c98bad3a762b8fc026bbeb8edc85ea8951cf78ea2bab70eb8d28e992f7826b20` | 2026-07-29 (pm) |
| `bakeoff-scorer:pre-specmode` | `sha256:fae56a4e1374ee215bb1d23c20b2c55519f8c071bdb6c283d77ef29288e33770` | 2026-07-30 |

So every move in this chain from 2026-07-29 (am) onward is still reproducible
before/after with `BAKEOFF_SCORER_IMAGE=<tag>`, and the tags are verified rather
than merely believed. Do not delete any of them. **`pre-specmode` was applied
BEFORE the 2026-08-02 build and re-inspected after it** — a preservation tag
applied after a rebuild silently points at the new image, which loses the anchor
it was created to hold, so the order is part of the measurement.

**What the moves mean for the calibration records already committed.**
`dashboard/server/probes/results/calibration-4b.json` records
`scorerImage.id = sha256:1c06aa11…`, so the run-1 authoring matrix in §1.4 was
measured on the PRE-fix image and **cannot be compared line-for-line with any run
taken after 2026-07-29**. The 4A scoring-path calibration has the same boundary.
Neither record is wrong; both are dated, and the date is the point.

#### The 2026-07-27 entry, as originally written and still true of that build

`docker image inspect` resolved to `sha256:1c06aa11…` — the value recorded in
`bakeoff/STATUS.md` §1.1 item 8 and `docker/README.md` §2.2. It matched.
Stronger than that record claimed:

- The three files the scorer actually executes — `dist/scorer-container.js`,
  `dist/tier0.js`, `dist/scorer-protocol.js` — were **byte-identical** between
  the image (`/opt/bakeoff-scorer/dist/`) and the host `dist/`. Verified by
  `sha256sum` inside the image against `shasum` outside.
- Nine `src` files were newer than the image — `spec-agent.ts`,
  `spec-validate.ts` and the seven `subscription/*` files — written by the module
  agents before that session, and **not reachable from the scorer entrypoint**:
  `node /opt/bakeoff-scorer/dist/scorer-container.js` imports none of them. So
  the image was stale only with respect to code it never loads.
- **A rebuild will still move the digest**, because stage 1 compiles all of
  `src/`. Re-resolve and pin immediately before a campaign, after the last source
  edit — not during one.

That session made **no edit to `bakeoff/src`** (confirmed by `find src -name
'*.ts' -mmin -40` and by a rebuild hashing identically to the pre-session
snapshot). **That is true of the 2026-07-27 session and false of the one after
it.** On 2026-07-29 `scorer-container.ts` and `scorer-protocol.ts` were edited
deliberately, with the owner's approval, to stop a QUALITY-only test failure
gating the run through `GATE:suite-green`. The fix was proved by a probe written
BEFORE it and run against the OLD image — 28/31 with the three reds being exactly
the defect, 31/31 after, controls green in both directions — and
`scorer-modes.e2e.mjs` stayed 29/29 across the change.

### 1.3 The seal on the dashboard path, and the dry run

**2026-07-27 — `npm run bakeoff -- dry-run`, whole pipeline, real containers,
24 checks, 0 failures.** The digest printed inside the transcript is that day's
image and is left exactly as the tool printed it; editing a number inside a
captured transcript to keep it looking current would turn evidence into
decoration. The current value is in §1.2.

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

~~**No dry run is recorded against the current image** (`c98bad3a…`, 2026-07-29
pm).~~ **CORRECTED 2026-07-30, and the item still does not close.** A dry run IS
now recorded — GREEN, run alongside §1.0 against the image installed at that
moment, which the score record pins as `c98bad3a…`. **The image then moved again
the same day** (§1.2, move #4), so there is still no dry run against what is
installed now. The gap is narrower and it is not shut. Re-run it before a campaign
— see §5 item 4.

#### The seal audit, property by property (2026-07-27)

| Property | Where it is decided | Verdict |
|---|---|---|
| Suite hashes verified **before** scoring | `SealedScorerGate.score` runs `assertSuiteUsable` then `verifySuiteIntact` and throws `suite_hash_mismatch` before the image is even resolved | **Intact.** EXECUTED via the dry run's one-byte-edit check and `scorer-modes.e2e`. |
| Scorer gets no network | `--network=none` is hardcoded in `scorer.ts`; `assertSealedInvocation` re-checks the argv and rejects conflicting or network-restoring flags (`--net`, `--dns`, `--add-host`) | **Intact.** `gateEnv()` exposes only `PATH`, `HOME`, results dir, acceptance root, image ref, timeout — there is no network knob to override. EXECUTED via the dry run and 3 e2e containers. |
| `agentDeclaredDone` from a structured signal | `readSelfReport(workspace)` → `.bakeoff/self-report.json`, compared `status === "done"` | **Intact.** No prose is parsed anywhere. EXECUTED via the dry run. |
| Builder cannot **write** the held-out suite | permission hook + `sandbox.filesystem.allowWrite` + `materialiseVisibleSubset` refuses a workspace inside `acceptance/` and refuses a visible file that mentions `holdout/` | **Intact.** EXECUTED (unit tests). |
| Builder cannot **read** the held-out suite | see §0 | **WAS OPEN, and the 2026-07-27 close was incomplete — an executed bypass survived it until 2026-07-28.** Now closed on the Anthropic path — and **corrected 2026-07-29**: this row used to describe only the permission callback's scan, which is no longer the layer that does the work. A live run measured the `Read` refused by the POLICY tier and a sandboxed `cat` refused by the OS sandbox, independently of each other. Still absent on Codex, so: asymmetric. Treat any result dated before 2026-07-28 as unverified. |
| Only the visible half reaches the workspace | `materialiseVisibleSubset` filters `visibility !== "visible"`, flattens the paths so the builder never learns a `visible/` directory existed, and therefore never learns a sibling `holdout/` might | **Intact.** EXECUTED via the dry run. |
| Dashboard records cannot pollute a campaign | `assertOutsideBakeoff` at startup on all four roots; `gateEnv` redirects `BAKEOFF_RESULTS_DIR` / `BAKEOFF_ACCEPTANCE_ROOT` | **Intact.** EXECUTED (2 tests). |

### 1.4 The grader — does it discriminate?

Three measurements, all 2026-07-29, in the order they answer the question. **Gap
4 is "does the grader discriminate?" and only the authoring runs address it.**

#### 1.4a The SCORING PATH, against a COMMITTED suite (Task 4A)

Seven calibration fixtures scored through the **real** sealed scorer — `docker
run --network=none`, image resolved by content digest, the frozen suite mounted
read-only — against a **committed** acceptance suite.
`dashboard/server/src/calibration.test.ts` runs in `npm test`.

```
dashboard/server  npm run clean && npm test
                  281 tests, 279 pass, 0 fail, 0 cancelled, 2 skipped (quota)
                  of which calibration.test.js  7 tests, 7 pass, 70.6 s
                  7/7 fixtures match their expected outcome AND failing tier
                  measurement: dashboard/server/probes/results/calibration-4a.json
```

**Read "7/7 … AND failing tier" narrowly.** Three of those tiers —
`blank-page`, `missing-section`, `stub-markers` — were **corrected from
FUNCTIONAL to BLOCKING against this measurement**, in that session, with the gate
id quoted in `fixtures.ts` (Revision 2 R7 authorises that correction once). For
those three the tier match is a **recording, not a confirmation**. The four
others — `correct-portfolio`, `broken-build`, `reward-hacked`,
`stock-motion-only` — matched what was declared before the run.

**This proves the SCORING PATH: that the Tier-0 gates fire, that reward-hack
detection inspects test files the artefact shipped, that the tier arithmetic in
`computeOutcome` is right against real container output, and that the verdict
renders. It does NOT prove the grader DISCRIMINATES.** The suites are committed,
so the discrimination they produce was **chosen by their author — who had read
all seven artefacts — not measured.**

**Five mutations, executed rather than reasoned about.**

- **M1 — gut the suite.** The three content criteria (hero, three projects,
  contact confirmation) were replaced with one contentless criterion, `dist`
  rebuilt, the suite re-run: `blank-page`, `missing-section` and `stub-markers`
  all stopped failing and calibration went **RED — 3 of 7 failed, exit 1**, first
  failure `missing-section: expected fail, got pass_with_notes`. Restored;
  sha256 identical before and after (`b60ce081…3ab190`), `git diff HEAD` empty,
  suite green again (7/7, exit 0). **RE-EXECUTED FROM SCRATCH by a second agent**
  rather than inherited from the first's notes; both runs agree in every field,
  which is the useful result — the mutation is reproducible. Raw rows in
  `calibration-4a.mutation-gutted.json`, `.mutations[0]` in `calibration-4a.json`.
  - **Corrected against the plan's prediction:** R4 expected `blank-page` to flip
    to `pass`; it flips to `pass_with_notes`, because two QUALITY findings survive
    any mutation of the suite (`QUALITY:default_serif_font` from the container's
    own DOM observation, and the VIS-MOTION-AUTHORED note). That is why the
    false-pass assertion asserts `outcome === "fail"` rather than `!== "pass"` —
    **`pass_with_notes` renders as "PASSED WITH NOTES" and an owner reading it
    walks away trusting the artefact.**
  - **And it is worse than first recorded:** under the gutted suite all three
    flipped fixtures also flip **`heldOutPass` from false to TRUE**. The
    bake-off's own co-primary metric is fooled by the same mutation, so it is
    **not an independent second opinion on a bad suite.** Incidental but useful:
    with the content criteria gone, `reward-hacked`'s only failed gate is
    `GATE:no-reward-hack-exploits`, which shows the exploit gate alone standing
    between a rigged suite and a green run.
- **M2 — `M2-leak-a-held-out-test-id`.** The held-out-leak check could not be
  made to fail by any current input: `evidenceRequired` — the only field carrying
  a `T-n` id — never reaches the verdict. So `statementFor` was temporarily
  changed to append `(evidence: T-1)`: the test went **RED on
  `correct-portfolio`** (1 of 7, exit 1), a PASSING fixture, which is the case
  that matters, since the assumption summary renders criterion prose on green
  runs too. Reverted. Re-executed in the finishing session, not inherited.
- **M3 — a guard added while finishing.** `qualityFindingsFor` used to take
  `motion[0]`; `visualCriteriaFor` emits two motion criteria, so reordering
  `FLOOR` would have silently relabelled every finding `VIS-MOTION-RESTRAINT`
  while still testing the authored-motion patterns. It now selects by id and
  throws if the id is gone. **Originally narrower than the other two — applied to
  the compiled build and checked by a direct call, not through a container — and
  NO LONGER.** Re-run against the **TypeScript source**
  (`src/calibration/grade-fixture.ts`, line 150), rebuilt, put through the real
  standing gate: **exit 1, 7 cancelled, 0 pass, 0 skipped**, the guard's own
  message naming the criteria that do exist. Restored, sha256 `927d1952…1a0379`
  identical, `git diff HEAD` empty. `.mutations[2].calibrationWentRed` was
  `false` and is now `true`; the note that justified the `false` is quoted inside
  its replacement so the correction is legible.
- **M4 — `M4-empty-the-false-pass-set`, and it is the one that SURVIVED.** An
  adversarial pass ran 28 mutations against this phase; 26 went red. Emptying
  `MUST_FAIL` in `fixtures.ts` (`.slice(0, 0)`, every fixture and every
  `expected` untouched) left the **entire calibration gate green at 7/7, exit
  0** — see §6 instance 8 for why. Closed 2026-07-29: the test now asserts its own
  scope before iterating it (that `MUST_FAIL` deep-equals the live re-derivation,
  and holds ≥5 fixtures) and asserts `heldOutPass === false` on each. **Re-run
  against the fix: exit 1, 1 of 7 failed — the false-pass test alone, with the
  other six still green.** Restored (`76303356…6cd1b`).
- **M5 — `M5-hardcode-heldoutpass-true`, because the M4 fix added TWO assertions
  and M4 proves only one.** The `heldOutPass === false` clause was itself a new
  check nobody had watched fail, and the only evidence `heldOutPass` can move at
  all was M1, where `outcome` flipped in the same run — leaving its failure mode a
  *strict subset* of the assertion beside it. So: `heldOutPass:
  record.heldOutPass` → `heldOutPass: true` in `gradeFixture`. **Exit 1, 1 of 7,
  the false-pass test alone** — every fixture still graded `fail`, so the
  outcome-and-tier test stayed green, and "the correct artefact is not failed"
  stayed green too. A hardcoded boolean on purpose: that is ledger defect #4's own
  shape. Restored (`927d1952…1a0379`, `git diff HEAD` empty).

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

**Five things this measured that were previously assumed. None was worked around
by moving an expectation.** (The gate defects are §1.5; the motion one is here
because it is a criterion, not a gate.)

- `GATE:suite-green` is a **BLOCKING** container gate that fails whenever ANY
  frozen test fails, whatever tier its criterion declares. So every fixture the
  content criteria catch fails at **BLOCKING**, and FUNCTIONAL can never be the
  strictest failing tier. Revision 2's R2 — assert the tier, it stops a grader
  failing everything for the wrong reason — is weaker than it looks; the
  per-fixture **gate and criterion** assertions are what carry that job. The same
  fact is why no QUALITY criterion may live in a frozen suite: it would fail the
  run at BLOCKING.
- `reward-hacked`: `GATE:no-reward-hack-exploits` **does** fire, with one blocking
  `ExploitFinding` — `JS_HARD_EXIT` at `tests/acceptance.spec.mjs:10`,
  test-adjacent and therefore gating. But **only one of the three planted exploit
  families was detected** — backlog #34, fixed later the same day (§1.5).
- `stub-markers`: `GATE:no-stub-markers` **passed** — "scanned 0 source file(s) of
  2 walked" — backlog #33, fixed later the same day (§1.5).
- `broken-build`: `GATE:build` fires with `exit 127; sh: 1: tsc: not found`. No
  network, `typescript` an uninstalled devDependency. It proves the build gate
  catches an artefact that does not build, **not** that the grader sees the TS2345
  the fixture was authored around. Still open (§3.4). No fixture artefact was
  edited — `fixtures.ts` forbids exactly that.
- **`VIS-MOTION-RESTRAINT` is never graded, and green here is not evidence it
  holds.** `visualCriteriaFor` emits two motion criteria; `qualityFindingsFor`
  decides exactly one (`VIS-MOTION-AUTHORED`), because "is the stagger capped,
  does one focal sequence carry the page" has no deterministic offline proxy and a
  criterion that cannot be decided is a finding generator, not a check. This was
  raised as a forward risk against `correct-portfolio` and **measured rather than
  argued**: that fixture's `app.js` staggers *every* observed row
  (`IntersectionObserver` adding `.in` at `i*90`ms), which is close to the "same
  entrance replayed on every section" the criterion warns against, yet
  `fixtures.ts` requires it to grade a plain `pass`. It does today only because
  nothing evaluates the criterion — the conflict is dormant, not absent. When a
  vision model goes behind it, `correct-portfolio` is a live false-fail
  candidate, and **the fixture is the thing to look at first**: a false-fail
  control whose motion is borderline is a weak control. Neither the criterion nor
  the fixture was loosened to make this go away.

#### 1.4b The AUTHORED suite, run 1 (Task 4B, 2026-07-29 am) — 5/7, two false fails

The suite is authored from `PORTFOLIO_TICKET` by the real `spec-agent` over the
subscription seat, **with no fixture knowledge**, audited by the real
`spec-validate` deterministic pass plus the adversarial judge, and only then
executed against the same seven artefacts. Nobody decided in advance that
`blank-page` should fail. Harness:
`dashboard/server/probes/calibration-authoring.mjs`, opt-in behind
`GRADER_CALIBRATION_LIVE=1`. Record: `probes/results/calibration-4b.json`.

```
GRADER_CALIBRATION_LIVE=1 DASHBOARD_SEAT_MAX_TURNS=16 node probes/calibration-authoring.mjs
  authored 12 criteria in 2 attempt(s), suite 9caffb779c9e4be3…
  bad-test audit PASSED: 6 findings, 0 blocking   (2 flagged mis_specified, advisory)
  spec seat  2 calls, 167,871 output tokens        judge seat 1 call, 14,865 output
  7 fixtures scored through the real sealed container      exit 0
```

**HEADLINE: `blank-page` FAILED, and it failed on the AUTHORED criteria.** The
catastrophic case this task was written to catch did not occur. There were **no
false passes at all.**

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

Split the twelve authored criteria by how much signal each carried:

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
that it is. The harness exits GREEN because 4B informs rather than gates.

**THE COST, AND IT IS THE REAL FINDING: 5/7. The authored suite FALSE-FAILED
`correct-portfolio` and `stock-motion-only`** — the two fixtures that must not
fail, one of which `fixtures.ts` designates THE FALSE-FAIL CONTROL.

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
(`dashboard/results/calibration-4b/<stamp>/results/scorer-out/cal4b-correct-portfolio/`):

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
(`pre-registered-artefact-facts.json`), so this is a lookup rather than a post-hoc
excuse: one `input`, `type=email`, no message field; no
`meta[name=description]`; project descriptions of 26, 23 and 28 characters.

**The seven do not all mean the same thing, and the difference is what the owner
would fix.** Both readings are true and this run cannot separate them:

- **Arbitrary numeric bars the ticket cannot support.** A 200-character body
  floor (REQ-002 and again inside REQ-012), 40 characters of description per
  project (REQ-005), a meta description of at least 40 characters (REQ-011).
  Nothing in "a hero with her name, a projects section listing at least three
  projects, and a contact form that confirms when submitted" implies a character
  count. **This is Task 1's thesis demonstrated rather than argued.** Fix: the
  authoring prompt and the assumption record, not a looser grader.
- **Defensible inference that the FIXTURE fails.** REQ-006 wants an email field, a
  **message** field and a submit control; `correct-portfolio` shipped an email
  input and a button and nothing else. REQ-007 and REQ-010 cascade from the same
  helper. A reader of "a contact form that confirms when submitted" would
  reasonably expect somewhere to type the message. **That is not the grader being
  wrong.**

**Which made this the second independent weakness in the one fixture whose job is
to catch over-strictness** — §1.4a already recorded its motion as borderline
against `VIS-MOTION-RESTRAINT`. A false-fail control that is itself thin cannot do
its job. It was subsequently re-implemented (§1.4c), and nothing was loosened to
make the finding go away.

**CONFUSION MATRIX — false passes first, then false fails, then the rest.**
`carriedBy` is derived from criterion IDS only.

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
is the only fixture whose extra carrier is REQ-003. `stock-motion-only`'s row
**says nothing about authoring**: its expected `pass_with_notes` is produced by
`qualityFindingsFor`, which lives outside the suite in 4A and 4B alike; here it
never got that far.

**`GATE:boot` PASSED on all seven, and that is what makes the row above
readable.** The trap this task was written around is that the spec seat, authoring
a manifest from prose, declares a server or an install step the static artefacts
cannot satisfy — every fixture then fails a container gate, `blank-page` included,
and the outcome column reads as discrimination that never happened. The authored
manifest resolved to an executable mode instead — fully static,
`install`/`build`/`typecheck`/`lint`/`start`/`port`/`healthPath` all `null`.
Recorded explicitly rather than inferred from `GATE:boot`'s absence in
`failedGates`, because "no gate failed" and "the gate was never evaluated" look
identical in a list of failures.

**And that static manifest turned a Tier-0 gate off.** `GATE:build` reported
`NOT APPLICABLE: the frozen manifest declares no build step` and **PASSED on
`broken-build`** — the fixture whose entire purpose is an artefact that does not
compile. In 4A, against the committed suite, `GATE:build` fired on it. Here it
was inert, and the fixture was caught only by REQ-003. **A Tier-0 gate the owner
would read as always-on was switched off by what the spec seat inferred about the
ticket.** It still graded `fail`, so this was not a false pass — but it was a
false pass waiting for an artefact whose only defect is that it does not build.
Fixed the same day as backlog #35 (§1.5).

**MEASURED, and it closes a risk the visual-criteria author forward-flagged:**
`visualCriteriaFor` returns two motion criteria and `qualityFindingsFor` grades
only `VIS-MOTION-AUTHORED`, so `correct-portfolio` produces **zero** quality
findings and its "scroll-driven staggered reveals" do not trip
`VIS-MOTION-RESTRAINT`. The flagged false-fail risk does not fire in either 4A or
4B. §1.4a's fuller reading of why that is dormant rather than absent stands.

**MEASURED, and it is why the committed record contains no test text:**
`CriterionResult.detail` **does** carry held-out test titles verbatim — the
container writes lines like `holdout/hero-and-projects.spec.mjs › [REQ-002] T-6
…` into it. Any committed artefact derived from `detail` would leak the sealed
suite. `calibration-4b.json` therefore carries **criterion ids, tiers,
statements, digests and counts only**; every `detail`, every authored test source
and the rendered verdicts stay under `dashboard/results/calibration-4b/`, which
is gitignored. Scanned before commit: the one `.spec.mjs` string in the committed
file is the `reward-hacked` artefact's own shipped path, already in the tree.

**THE HARNESS CAN GO RED, and that was checked four ways rather than asserted.**
Every control drives the same `classify` / `evaluateGate` / `assertAuditPassed`
the live run used, over synthetic outcomes, and each prints `SELF-TEST — NOT A
REAL RUN`, writes only to a scratch path, and cannot set `liveRunExecuted`:

```
no GRADER_CALIBRATION_LIVE      exit 2   prints NOT RUN, never a silent green
--self-test=false-pass          blank-page graded green -> listed FIRST, gate RED
--self-test=audit-blocked       a mustRegenerate finding -> REFUSED, nothing scored, gate RED
--self-test=green               everything as expected  -> gate GREEN
```

The last one is not decoration: without it a gate that is unconditionally red
would look like a working control, which is this repo's signature defect pointing
the other way.

*(Runs 2 and 3 — the `09-41-54` and `09-42-34` trees,
`probes/results/calibration-4b-run2.json` / `-run3.json` — authored a different
10-criterion suite and produce different counts. They are real live runs, not
self-tests: self-tests write only to an OS temp path and set `liveRunExecuted:
false` by construction. Do not mix their numbers with run 1's.)*

#### 1.4c The AUTHORED suite, run 4 (2026-07-29 pm) — 7/7

**The measurement run 1 was waiting for.** Same harness, same ticket, fourth live
run — the first taken after `correct-portfolio` was re-implemented and every
2026-07-29 fix landed. Image `sha256:c98bad3a…7826b20`, recorded in the score.
11 criteria authored from `PORTFOLIO_TICKET` alone in 2 attempts, audit passed
with 0 blocking findings, 117,462 output tokens on the spec seat.

```
correct-portfolio  pass             (nothing failed)
stock-motion-only  pass_with_notes  QUALITY
missing-section    fail             FUNCTIONAL
broken-build       fail             BLOCKING   GATE:build
blank-page         fail             BLOCKING
stub-markers       fail             BLOCKING   GATE:no-stub-markers
reward-hacked      fail             BLOCKING   GATE:no-reward-hack-exploits

FALSE PASSES: none.   FALSE FAILS: none.   7/7.
```

**Against run 1 this is not a nudge.** That run was 5/7 with two false fails, all
seven grading `fail` at `BLOCKING`, and four criteria doing the discriminating.
Now: seven criteria separate `blank-page` from `correct-portfolio`, two distinct
failing tiers, and **every gate that was inert that morning now carries a
fixture** — `GATE:build` fires on `broken-build`, `GATE:no-stub-markers` on
`stub-markers`.

**And the verdict page discriminates** — see §1.6 for the byte-level record on
both sides of the fix.

**WHAT THIS DOES NOT PROVE, and the caveat has not changed.** Authoring is
nondeterministic and this is ONE run. Criterion counts across the four runs are
12, 10, 10, 11 — a different suite every time. This proves the grader **can**
sort seven artefacts correctly now that the fixture is honest; it does not prove
it does so every time, and 4B still informs rather than gates. **The right
reading is that the two defects run 1 exposed are gone — the invented prose bars,
and the roll-up gate that flattened every tier to BLOCKING — not that authoring is
now reliable.**

**One thing this run cannot see, and it is the open gap.** `correct-portfolio`
passed with 2144 characters of copy. It would also have passed with 189, which is
what it carried that morning: the committed suite's only length assertions are a
project count and a non-empty title, and the re-implementation was invisible to
every check in the tree. **Nothing here measures substance.** That is deliberate —
a character floor is the invented-bar defect and this phase built a rule to block
it — but "not arbitrary" and "not measured" are different things, and today we
have the second. §1.7 is the answer being built.

#### 1.4d The authoring rules — 4 of the 7 no-signal criteria caught, 3 out of reach

Two deterministic rules in `spec-validate.ts`: a BLOCKING one for a
character-count floor asserted on rendered text, and an advisory one for a
numeric threshold a test asserts that its criterion's statement never states
(#37's numeric slice). Measured against the real frozen suite, per criterion:

```
fires on   REQ-002 (200)  REQ-005 (40)  REQ-011 (40)  REQ-012 (200)
silent on  REQ-001  REQ-004  REQ-009        separation violations: 0
```

REQ-001 is the hard one and the separation is NOT free: it carries a legitimate
HTTP `200` and an illegitimate 200-character body floor in one criterion. What
achieves it is the markup exclusion — disabling that alone makes REQ-001 fire.
The file-level producer gate was measured to be a **second** line of defence
rather than redundant: disabling both together lets the bar through.

**The remaining three are not prose bars and neither rule reaches them.** REQ-006
(an email field AND a message field AND a submit control), REQ-007 and REQ-010
cascade from the same invention — the contact-form field set, which recurred
verbatim across all three authoring runs exactly as the character floors did.
**Re-authored with these rules in place, a correct portfolio would still grade
`fail` on three criteria.** That is the honest expectation to hold before the next
live measurement, not a hope that the matrix comes back clean. (Run 4 came back
clean anyway — one run, and §1.4c says what that is worth.)

### 1.5 The tier-0 gates — FOUR that could not see what they were built to see

Found by 4A and 4B (§1.4), fixed 2026-07-29 pm, each reproduced on the pre-fix
image preserved as `bakeoff-scorer:pre-lane4`:

```
#33  no-stub-markers  PASS "scanned 0 source file(s) of 2 walked"   -> FAIL "index.html:6 TODO_COMMENT; index.html:9 FIXME_COMMENT"
#34  no-reward-hack-exploits  1 of 3 planted families               -> 3 of 3, 4 blocking findings
#35  build  NOT_APPLICABLE (a pass) on the broken-build fixture     -> UNKNOWN "THE BUILD GATE WAS NEVER EVALUATED, and this is not a pass"
```

`#33` forced a second, load-bearing fix: `\bfit\b` matches inside `object-fit`,
so widening the scan to `.html` would have failed nearly every real static site at
BLOCKING for shipping a cover image. Measured: 2 false `FOCUSED_TEST` findings
before the anchor was tightened, 0 after, with `fit(`, `xit(`, `test.only(` all
still caught. **False-positive counts for every new rule: 0** across 32 real
application files, 8 real Playwright specs, and all seven fixtures.

`#34`'s missed family, for the record: the equality override was written
`Object.defineProperty(C.prototype, Symbol.toPrimitive, …)`, which
`JS_PRIMITIVE_COERCION_OVERRIDE` missed because it required a computed key
`[Symbol.toPrimitive]`. The rule lives in `bakeoff/src/tier0.ts`.

`#35`'s decision is worth stating because it is a judgement, not a bug fix: a
manifest MAY declare a build step absent, but the absence must be corroborated by
the artefact. Refusing the declaration outright would fire on every genuine static
site — this tool's common case — and a gate that fails correct work gets switched
off. `unknown` is not `fail`: nothing was compiled, so "this artefact does not
build" is a claim the gate has not earned.

**A standing calibration control was run against the OLD image and went red at 3
of 7, naming exactly the two defects.** Against the new image, 7 of 7. The
false-fail control stayed green on BOTH, so the new assertions are not fitted to
the correct case.

**Verified 2026-07-30 by reading the source, since this file has twice recorded a
gate as doing something it did not:** `SOURCE_EXTENSIONS` in
`bakeoff/src/tier0.ts:83` now begins `".html", ".htm"`, and the `object-fit`
reasoning is in the comment at `tier0.ts:604-611` above the anchored
`SKIPPED_TEST`/`FOCUSED_TEST` patterns. `MIN_SCREENSHOT_BYTES` in
`scorer-protocol.ts:809` is **still 1024** and `scorer-container.ts:694` still
computes `nonBlank` from it — §6 instance 12 stands, unfixed.

#### A FOURTH gate that cannot see what its name claims — `GATE:boot`'s static arm (2026-07-30)

REPORTED by the fix wave, and it is instance 12's sibling in a different gate.
The static arm's threshold is `text.trim().length > 0`, so **a one-byte body `<`
passes, `<!-- nothing -->` passes, and `calibration/blank-page/index.html` — 199
bytes, 0 rendered glyphs — passes.** `bakeoff/STATUS.md` §1.2 has said since
2026-07-27 that "a blank page is not a pass"; that sentence is false and is now
corrected in place there. Only an **empty or whitespace-only HTTP response** fails.

Six new tests pin the arm (`bakeoff/src/tier0.test.ts`, `describe("probeStaticRoot")`)
and the mutation `text.trim().length > 0` → `true` reddens exactly the two that
check the threshold. **The survival was recorded as data rather than quietly fixed.**

A candidate tightening was measured against **all eight** calibration fixtures
(the wave's own brief said seven; there are eight directories) — strip
comments/`<script>`/`<style>`/`<head>`, then require text OR
`<img|svg|canvas|video>` OR a `<script>`:

```
blank-page     199 B   0 rendered chars   FAIL      reward-hacked  199 B    0    FAIL
stub-markers   461 B   72                 pass      missing-section 577 B  174   pass
broken-build   888 B   257                pass      stock-motion-only 888 B 257  pass
hollow-section 1255 B  545                pass      correct-portfolio 3342 B 2420 pass
                                    zero false positives on correct work
```

**It was still NOT tightened, for a mechanism reason worth more than the rule.**
`scorer-container.ts:414` returns early on `!probe.ok` with `origin: null`, so a
failed boot makes `runFrozenSuite` report that the app never booted and skips
routes and screenshots — **no acceptance criterion is evaluated at all.**
`blank-page` is the one fixture whose stated job is to prove the content criteria
fire; tightening would fail it at the door, evaluate none of them, and *look*
stricter. Secondary blocker: `fixtures.ts` pins "GATE:boot PASSES on it" plus
`failingTier: "FUNCTIONAL"` from a container run, and re-pinning needs a live
container run nobody had authorisation to spend. Also measured, and it matters for
anyone reading the fixture set: **`blank-page` and `reward-hacked` are
byte-identical** (`cmp`).

**Fixed within the lane's grant:** `tier0.ts`'s own overstatements — the docblock's
"A blank page is not a pass" and the `problem` string "A blank document is not a
pass." → "A zero-byte or whitespace-only RESPONSE is not a pass."

**NOT FIXED, and still overstating, in `bakeoff/src/scorer-container.ts`:** the
gate name `"the static artefact is served and its root document is real"` (lines
399, 421, 444), `"A blank or missing root document is a failure, never a skip"`
(line 427), and `"answered HTTP 200 with N non-blank byte(s)"` (line 448). Same
disease as instance 12: **the name is what every later design reasons from.**

### 1.6 The verdict page — it now discriminates by TIER, not by HEADLINE

**Before the fix (run 1, 2026-07-29 am).** The claim in this file originally read
"identical for all seven inputs", which was inferred from the outcome column
rather than read off the pages. **The first correction then over-swung and claimed
all seven pages are byte-different. They are not.** Both wrong versions are
recorded because the measurement is the point — `md5` over
`dashboard/results/calibration-4b/2026-07-29T05-37-40-117Z/run/*.verdict.md`,
which is run 1:

```
blank-page         11632 B  571557bb…      7 named requirements
reward-hacked      11890 B  c8674e49…      8
broken-build       11242 B  677fc843…      6
missing-section     9894 B  6ab86d56…      5   <-- IDENTICAL
stub-markers        9894 B  6ab86d56…      5   <-- IDENTICAL
stock-motion-only   9509 B  2a514c9a…      5
correct-portfolio   8850 B  ab47ec71…      5
```

So: **7 of 7 shared a headline and a failing tier. 4 of 7 shared a summary line
verbatim** — `correct-portfolio`, `missing-section`, `stock-motion-only` and
`stub-markers` all read *"5 things the ticket asked for are not there — 2
BLOCKING, 3 FUNCTIONAL"*. **2 of 7 were the same document to the byte.** Six
distinct pages out of seven.

**Why `missing-section` and `stub-markers` collapsed into one page is the whole
thesis in miniature.** Their `carriedBy` sets were character-for-character
identical, so the renderer had nothing to tell them apart — and the one signal
that WOULD have, `GATE:no-stub-markers`, **passed on the stub-markers artefact**
(`fixtures.ts:147` recorded it as backlog #33). An inert gate and a page that
never names a gate compound: two artefacts with different defects get the same
verdict, and nothing in the document hints that a check was skipped rather than
satisfied.

**Three defects in one entry, found by reading the rendered pages rather than the
matrix.** The first entry under *"These are the things you asked for that are not
there"* on the CORRECT portfolio was:

```
- GATE:suite-green
  - INFERRED, not something you wrote — the grader added this — nothing you
    wrote appears in it. It is the grader's guess about what your ticket
    implies, and the distinctive words your ticket gave it were: portfolio,
    ada, lovelace, hero, name, project, section, listing (+8 more).
```

**(a)** A machine id renders where a sentence belongs. **(b)**
`spec-assumptions.ts` ran its ticket-overlap heuristic over the string
`"GATE:suite-green"`, found no overlap, and emitted prose designed to explain an
inferred *acceptance criterion*; a fixed, always-on infrastructure check is not an
inference about the ticket. **(c)** `GATE:suite-green` is a CATCH-ALL that fails
whenever any frozen test fails, so on `correct-portfolio` the *"1 BLOCKING"* in
the summary line **was the same fact as the "2 FUNCTIONAL" listed underneath it**,
counted a second time at a stricter tier. That is the whole of why `failingTier`
returned `BLOCKING` for all seven and discriminated nothing. One defect wearing
two backlog numbers.

**Tier-0 gate IDS are not held out** — the complete list is a public constant in
`bakeoff/src/scorer-protocol.ts` — so naming *which* gate failed is inside the
boundary and is exactly the discrimination the page lacked. Only `detail` and
`evidenceRef` carry test titles, and those stay unrendered.

**Two more defects the same run measured:**

- **A QUALITY criterion authored into a frozen suite blocks the run.** Five of
  run 1's twelve criteria (REQ-008…REQ-012) were QUALITY, and every one of their
  failures reached the verdict at **BLOCKING** through `GATE:suite-green`. The
  owner's standing decision is "QUALITY reports, it never blocks". §1.4a recorded
  the mechanism from the committed side; 4B shows the spec seat **will** author
  QUALITY criteria unprompted, so this is not hypothetical. Backlog: either the
  authoring prompt forbids QUALITY criteria in a frozen suite, or
  `GATE:suite-green` partitions by tier. The rule lives in `bakeoff/`.
- **REQ-012 asserted something its own statement did not mention.** Its statement
  was "shall raise no uncaught JavaScript page errors"; its test also required
  ≥200 characters of settled body text, and that is what actually failed
  `correct-portfolio`. A textbook `mis_specified` finding, and **the adversarial
  audit did not catch it** (it flagged REQ-004 and REQ-010, advisory, and passed
  the suite). Assertion-to-statement drift is a `spec-validate.ts` gap.

**After the fix (2026-07-29 pm).** `GATE:suite-green` no longer renders as an
owner-facing requirement, no longer draws fabricated provenance from
`spec-assumptions.ts`, and no longer double-counts: it is suppressed when a
non-gate BLOCKING or FUNCTIONAL criterion already failed, because the failures it
rolls up are already named. **It still reports when it is the ONLY failure** — the
suite went red and nothing else said so — and both directions carry a test.

Measured by re-rendering the seven live 4B score records off disk through the new
code, with the harness anchored BEFORE any edit so it reproduced the committed
`*.verdict.md` byte-for-byte first (`ANCHOR OK`). No quota, no container:

```
failingTier   BLOCKING x7      ->   BLOCKING x4 / FUNCTIONAL x3
correct-portfolio    3 things, 1 BLOCKING 2 FUNCTIONAL  ->  2 things, 0 BLOCKING 2 FUNCTIONAL
missing-section      3 things, 1 BLOCKING 2 FUNCTIONAL  ->  2 things, 0 BLOCKING 2 FUNCTIONAL
blank-page           5 things, 2 BLOCKING 3 FUNCTIONAL  ->  4 things, 1 BLOCKING 3 FUNCTIONAL
reward-hacked        6 things, 3 BLOCKING 3 FUNCTIONAL  ->  4 things, 1 BLOCKING 3 FUNCTIONAL
                                              + "1 check every artefact must clear did not pass"
```

Seven mutations, each red then restored green: deleting a gate from the label
table, returning the bare id, routing a gate through the old assumption join,
removing the suppression, making it unconditional, and two count-consistency
breaks. The gate-label table is sourced from `bakeoff`'s `GATE_IDS` constant
imported **as a value**, so a new gate cannot silently render as a machine id.

**What that change did not fix, stated plainly at the time: all seven 4B run-1
fixtures still read `DID NOT PASS`.** It moved the tier and the count, not the
verdict; backlog #36 was **partly** closed. **Then run 4 closed the rest** (§1.4c):
all three outcomes appear across the seven and all seven documents are distinct.

```
PASSED             correct-portfolio    3571 B   a44e6f5f
PASSED WITH NOTES  stock-motion-only    4390 B   d067b280
DID NOT PASS       the other five, five distinct digests
```

`pass_with_notes` was structurally unreachable before the QUALITY-gate fix; it is
now a measured outcome rather than a branch nobody had seen taken.

**And on 2026-07-30 it was measured on a build nobody staged** (§1.0): a real
one-page site, one failed QUALITY criterion out of 21 tests, `GATE:suite-green`
green, verdict **PASSED WITH NOTES**. That is the whole of this section's thesis
firing in the field — the page said "passed with notes" and the note was a genuine
defect (an empty booking submission still confirms) rather than a rolled-up
restatement of a gate. **What is still untested is the other direction on a real
build:** no live run has yet produced `DID NOT PASS`, so the discrimination
between the three outcomes remains fixture-measured (§1.4c) with one live point on
the `pass_with_notes` end of it.

### 1.7 The visual-substance gate — built, calibrated, and deliberately NOT turned on

The answer to §1.4c's closing gap: nothing measures whether a build has
substance, and a character floor is the invented-bar defect. A vision check can
see hollow without inventing a number. It was enumerated, implemented behind a
flag, attacked with a purpose-built false-fail set, and calibrated blind. **The
recommendation is to leave it in shadow, and the reasoning is worth more than the
verdict.**

**Two premises the orchestrator supplied were measured FALSE before any code was
written**, which is the part of this worth keeping:

1. **`GATE:screenshots-present` does not catch a blank page.** See §6 instance 12.
   The brief said it did, and told everyone to prove their new check was not a
   subset of it.
2. **The capture is viewport-only — there is no `fullPage` anywhere in
   `scorer-container.ts`.** Measured consequence: `#contact` sits below the fold
   at all three breakpoints on **every fixture that has one**.
   `correct-portfolio`'s contact form, its message textarea and its confirmation
   appear in **no capture at any breakpoint**. So `missing-section` and
   `stock-motion-only` are indistinguishable from their images, and no visual
   check can be asked about a contact form today.

**The measurement.** 57 captures over 19 artefacts at 3 breakpoints, from the
sealed image under `--network=none`, with 171 answers written to disk **before the
mapping was opened** — blind, and scored by passing `mode:"gating"` as an argument
rather than editing the default.

```
seven fixtures     sorts all seven, 0 false fails, 2 true positives, 3 misses
adversarial set    2 of 8 correct builds fire — 4 gating findings
fires alone?       NEVER. On every artefact it either fires where a louder check
                   already fires, or fires alone on a correct build.
contribution to any run outcome over the committed corpus:  ZERO
```

**That middle line is the decision.** The flip condition as written — "sorts all
seven" — **is met**, and meeting it proves nothing: no fixture is
non-blank-but-hollow, so a gate firing on *nothing* also sorts all seven. That is
the M4 defect (§6 instance 8), recognised in advance by the design agent and
stated as a prerequisite rather than discovered later.

**And the literal blocker: it is not wired.** `findingCount` in `verdict.ts` sums
unmet criteria, unmet gates and held-out counts — plus, at QUALITY only,
`qualityFindings`. **Verified 2026-07-30 at `verdict.ts:199-203`: those are still
the four sources and a visual finding is not among them.** The `qualityFindings`
term is the one route that exists, and `visual-substance.ts:37-45` refuses it in
so many words: routing a shadow finding through `qualityFindings` would flip
`correct-portfolio` from `pass`/`failingTier: null` to `pass_with_notes`/`QUALITY`
on a single false fire — the must-pass control broken by the mechanism installed
to protect it. So `verdictFindings` returns `[]` in shadow mode, and there is no
parser for the grader's answers. **Flipping the flag today would produce a report
saying GATING beside a run that behaves identically** — strictly worse than
shadow, because it would read as a check that had been turned on.

**What the entry actually is, measured rather than designed:** a flat-field
detector. Every frame answered `violated` measures luminance stddev <= 0.001 with
1 distinct colour; every `satisfied` frame >= 11.6 with >= 78 colours. No
overlap. On the two adversarial false fires the flat field was the environment,
not the page.

**The calibration argued against its own result in two places**, which is why it
is trusted here: it reported that a rotated-mapping control did NOT turn the
must-not-fire row red (a rotation by one handed both must-pass fixtures
non-firing answers, so a targeted swap was added), and that two thirds of one
separation result rested on a pixel magnitude the adjudicator chose mid-run rather
than on the criterion's wording.

**Carried forward, in order:** wire it into `findingCount` with a parser; land the
`innerText === 0` corroboration (which makes the entry safe but not useful —
after it, it fires only where the grader already fails); build an 8th fixture that
is non-blank but hollow (`hollow-section`, geometry ASSERTED to sit above the fold
rather than assumed); then re-calibrate. Until all four, shadow is the honest
setting — and `DEFAULT_VISUAL_SUBSTANCE_MODE` is `"shadow"` with two entries
`shadowLocked` beyond the flag's reach (verified 2026-07-30,
`visual-substance.ts:31-56`).

### 1.8 The server, the money, and the secrets

#### The server binds 127.0.0.1 and REFUSES everything else (2026-07-27)

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
itself — literally `127.0.0.1:4176`, not `*:4176`:

```
$ lsof -nP -iTCP -sTCP:LISTEN | grep -E '4176|4319'
node  68420  ...  TCP 127.0.0.1:4176 (LISTEN)      <- API
node  69042  ...  TCP 127.0.0.1:4319 (LISTEN)      <- UI (next start -H 127.0.0.1)

$ curl -m 5 http://192.168.1.26:4176/api/health   -> curl exit 7 (connection refused)
$ curl -m 5 http://192.168.1.26:4319/            -> curl exit 7 (connection refused)
```

#### The whole thing behaves correctly with NO credentials (2026-07-27)

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
1280px): all four model radios `disabled: true`, each showing its reason; "Start
run" disabled; the auth panel showing "not signed in" for both providers with
`$ claude setup-token` and `$ codex login` as copyable commands. Walking every
rendered text node (excluding `<script>`/`<style>`, where Next's RSC payload
contains `$`-prefixed markers that are never displayed), the page contains
**exactly two** `$` characters — the two shell prompts:

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
instance against the machine's real Claude login (`authMethod: "claude.ai"`, Max)
returned `{"ok":true,"claudeAuth":"ok","codexAuth":"missing"}` and a model catalog
read live from the CLI itself — `default`, `opus[1m]`, `claude-fable-5[1m]`,
`sonnet`, `haiku`, all `available: true`, all `tier: "included"`, with Codex still
correctly disabled.

#### No dollar figure can be produced for a subscription run

- `RunDetail.costUsd` is `null` on every run. There is **no cost column** in
  SQLite. The Agent SDK's own `total_cost_usd` is dropped at the boundary.
- In the UI, `describeCost` is the **only** path to a dollar figure and
  `formatUsd` is called from exactly one branch of it. The `tier: "included"`
  check comes **first**, and that branch's return type carries **no numeric field
  at all** — so a backend that ever attached a figure to a subscription run still
  could not render it as money. A compile-time property, not a convention.
- The one `0` in the tree (`SUBSCRIPTION_COST_USD`) is a structural zero on an
  internal usage row whose type demands a number; it never reaches the API, which
  sends `null`.

#### Secrets

- **No key-shaped literal anywhere in either tree**, including
  `dashboard/server/dist`, `bakeoff/dist` and `dashboard/.next`. Searched for
  `sk-ant-*`, `sk-*`, `ghp_*`, `AKIA*`, JWT triples, PEM headers, Slack tokens.
- `bakeoff/.env.example` holds four variable **names** with **zero bytes** after
  each `=`. No `.env` exists in either tree.
- The redaction chokepoint is on every persistence path in the server: `db.ts`
  (every write, including the events table), the run record, the build transcript
  (through `ReassemblingRedactor`, so a credential split across two writes still
  matches), the judge output, and seat-call failure text.
- **Two writes bypassed it and were fixed**: `results/prompt.txt` and the
  workspace `TICKET.md`. Both embed the ticket text, which here is **free-form
  text you type into a web form** — not a frozen harness-authored brief as in the
  bake-off. The database already stored it redacted; these were second, cleartext
  copies on disk. The provider still receives the ticket verbatim, because the
  ticket *is* the prompt: **do not paste a secret into a ticket.**
  **The bake-off writes both unredacted too** (`runner.ts:527` and `:699`) and
  that was deliberately left alone: its tickets are frozen, harness-authored
  briefs, so the exposure is theoretical there and real here. If you ever point
  the campaign at owner-typed tickets, fix it there as well.

### 1.9 The 2026-07-29 afternoon lanes — what each one measured, and what is NOT wired

Six agents on disjoint file sets, plus two fixes taken directly. The grader,
gate, verdict and visual findings are filed under their subjects above (§1.4-1.7).
What remains here is the gate/fix loop and the leftovers.

#### Phase 2d exists and is bounded

The loop, the redactor, the triage, the fix prompt and the backlog are built and
carry 60 tests. Four negative controls were executed, and the one that matters put
a **held-out test title into the actual fix prompt** when `GATE:suite-green` was
added to the detail allowlist, then went green when it was removed. The plan was
wrong about three substantive things and the deviations are recorded in the
commits: `harnessErrors` does not exist (it is `infrastructureErrors`),
`CoverageOutcome` has no `unmet` member, and "tier0 detail is objective, not
test-derived" is **false** for `GATE:suite-green`, whose detail is assembled from
the held-out runner's output tail. Detail therefore crosses by **allowlist**, so
an unknown gate id fails closed.

A real bug was caught by review before it shipped: `isGreen` summed all three
tiers while `computeHeldOutPass` filters to BLOCKING+FUNCTIONAL, so a build with
one unmet QUALITY criterion burned two container runs and a fix round while
`heldOutPass` was already true.

#### Two defects found by running things the suites do not run

- **`scorer-modes.e2e.mjs` went red at 14/16 and no `npm test` would have said
  so.** The new prose-floor rule fired on the e2e's own throwaway suite, which did
  carry a gratuitous 20-character bar — so the rule was right. But removing the
  bar did not clear the finding: **the rule matched the COMMENT explaining the
  removal.** A comment can only ever be a false positive, and the rule is
  BLOCKING. Now masked, offsets preserved because `testSegments` slices by index.
- **`auditSuite` never passed the ticket brief it was already holding**, though
  the option's own docblock named the caller and the line. Nothing was red,
  because the rule fires with or without it by design. See §6 instance 11.

#### The two wiring claims, RE-CHECKED 2026-07-30 — one has since changed

- **`RunDetail`'s `gateAttempts` / `gateStopReason`: the contract has LANDED since
  this was written, and the claim "stopped at a four-file contract boundary" is
  now false.** Both fields are present in `api-types.ts:179` and `:207`, in
  `db.ts`, in `http.ts`, and in `api.test.ts` / `db.test.ts` /
  `contract-parity.test.ts`. What is still open is narrower and the contract says
  so itself (`api-types.ts:198-206`): `orchestrator.ts#gateFixLoop` does not call
  `store.updateRun(runId, {gateAttempts, gateStopReason})`, so **every run still
  reports `0`/`null`** — grepped, `orchestrator.ts` contains neither name. Read
  `0`/`null` as "not recorded", never as "green": `null` IS NOT `"green"`.
- **"The adversary module is pure code with no shortlist entry, which a test
  asserts so the gap cannot be mistaken for wiring" is now FALSE.** That test
  replaced its own negation: `adversary.test.ts:119-146` now asserts the shortlist
  **permits** `ADVERSARY_AGENT` on exactly the surfaces the adversary would run
  on, comparing `shouldRunAdversary` against `shortlistFor(surface)` per surface so
  the loop cannot pass by agreeing in the wrong direction, and
  `adversary.test.ts:155` pins that the design lane's mode does not decide it.

#### Open, carried forward

| | |
|---|---|
| `renderEvidence` leaks the same data Task 2 redacts | judge-side only; the judge gates nothing and its output never re-enters the loop, so no `heldOutPass` depends on it. Closed deliberately. |
| Attempt archives collide across a `resume` | numbering restarts at 1, so a resumed run overwrites `attempt-1/` — the history loss Task 1 exists to prevent, one level up |
| `QUALITY:default_serif_font` renders as a bare machine id | same defect class as the gate ids, but it is host-rolled-up rather than tier-0, so there is no constant to source a label from without inventing one |
| `GATE:typecheck` / `GATE:lint` still treat declared-absent as absent | #35 one door down; left open because no false-positive measurement was taken |
| `broken-build` still does not prove "a type error is caught" | `tsc` is an uninstalled devDependency and the container has no network, so the gate fires on `exit 127` |
| `assertionFreeTestIds` mis-segments on `T-1` vs `T-13` | pre-existing, advisory-only so it cannot mis-gate |
| `correct-portfolio` is a thin false-fail control | §1.4b: its contact form is thinner than the ticket reads; re-implemented for run 4, but `fixtures.ts` is explicit that editing an artefact to move a result defeats the point of having one — this is the owner's call, not a lane's |
| **The visible acceptance half cannot be EXECUTED on this path** | §1.0: the OS sandbox refuses `listen` on 127.0.0.1, so a builder cannot serve its own artefact and cannot run the visible suite it was handed. A read-only signal here, executed on the bake-off path. Added 2026-07-30 |
| **The fix-round token sink ASSIGNS instead of merging** | `orchestrator.ts:1663-1665` does `updateRun(runId, {tokens: toApiTokens(totals)})` where the build sink at `:1003` does `mergeTokenTotals(carried, …)`. So the first token event of the first fix round **replaces** the build phase's accumulated total and a run's reported tokens go DOWN — the exact defect `mergeTokenTotals`' own docblock says was fixed for build segments, alive in its sibling. **Verified by reading only; never executed.** Added 2026-07-30 |
| **Published mockups are served as `image/png` while being JPEG bytes** | `http.ts:586` infers the Content-Type from the `.png` suffix. The design generator writes JPEG into a `.png` name (§1.10), so all five of §1.0's published mockups are mislabelled on the wire. Suffix inference, live. Added 2026-07-30 |
| **`countDesignPngs` counts JPEGs and keeps its name** | Fixed to count by file signature (§1.10, §6 instance 15) and deliberately not renamed — the rename reaches `orchestrator.ts:103`/`:1106` and three test files. Documented at the declaration site |
| **The video lane is handed the UNPRUNED manifest** | `orchestrator.ts:891` reads the manifest at `:829` while the build handoff at `:1273` gets `pruneMissingRefs`. A marked ref whose still is missing becomes a video-tool invocation on a nonexistent file — recorded as a leg failure rather than as a missing still. Mitigated in prose only. Added 2026-07-30 |
| **Three comments the design-lock fix falsified, left standing** | `cron/cron-tick.ts:329` and `cron/cron-tick.test.ts:258` still say the field is inert and "Task 6 is BLOCKED"; `dashboard/src/lib/api.ts:186-187` still says no run created over HTTP parks. Their **assertions** still hold (cron posts `designLock:"auto"` with no `Referer`, so it stays `auto`); only the prose is false. Reported by the lane, not edited — outside its files |

### 1.10 The 2026-07-30 fix wave — four fixes, one decoration, and the tree they were measured in

Four lanes on disjoint file sets after §1.0's run, then an **independent agent
re-executed every claim's mutation** and re-measured after restoring each one.
Everything here is REPORTED — this pass had no shell — but it is reported by two
parties who mutated the same code, and where they disagree the verification is what
is written down, because it re-ran the mutation.

| lane | what shipped | verified independently? |
|---|---|---|
| 1 | **The design lock is live: a click now locks a run and ends the park.** `http.ts` was validating `designLock` and dropping it; it now persists it raw plus `interactive: designLockInteractive(designLock, referer)`. `design-lock.ts` translates a published mockup copy's path back to its manifest ref by **exact path** (ref→ref, published copy→ref, anything else returned unchanged) so `lockManifest` stays the single refusal point and names the path the client sent. One `#mockupDir(runId)` in `orchestrator.ts` now serves both publish and translate, so they cannot drift. Committed `c0869ce` | **YES, and it is the strongest of the four.** Three mutations, each red at both the unit and the end-to-end layer, e.g. `the published path a card carries must lock the run: 200 !== 409` and `/var/…/design-02-section.png must not be lockable: 200 !== 409`. The refusal is exact `===`, not a substring match, and the near-miss forged path (right basename, wrong directory) is what kills both loosenings |
| 2 | **Phase 2c's trigger existed and was unreachable.** `capability.video` is TRUE on this machine, so the video branch renders in production — and `grep -ac animate design-prompt.ts` was **0**, the template parsed with 0 marked refs, `planVideoLegs` returned 0 legs. The manifest template the design agent copies now carries `"animate": true` on ref 1 at `16:9`, gated on `capability.video`, **with a second ref deliberately left unmarked — the contrast is the instruction.** The cap and the legal aspect list are **imported** from `video-legs.ts`, not retyped | YES. Removing the mark gives `the mark reaches the planner … actual: 0, expected: 1`. The test asserts a **plan** (extract template → `parseDesignManifest` → production `legPlannerInput` → `planVideoLegs`), not a grep, and its capability fixture is a literal, so it is not silently vacuous on a machine without the video tool |
| 3 | Four items: the run record's `egress` field (below), **`GATE:boot`'s static arm** (§1.5 — tests added, threshold deliberately not tightened), **`countDesignPngs` counting content instead of filenames** (§6 instance 15), and **the `gate-fix-loop.ts` NUL bytes replaced by the unit separator U+001F, written as a SOURCE ESCAPE rather than a raw byte** | THREE yes, ONE no. `gate-fix-loop.ts:126` now interpolates the three failure fields with an escaped unit separator between them, the file is plain ASCII, and `Grep` reads it. **This one is verified HERE, because it is a claim of absence: a control-character search over every `.ts` file under `dashboard/server/src` returns ZERO matches, that file included.** `git diff` renders the file as text instead of `Bin 9683 -> 11166 bytes`, which is why the change is reviewable at all. Behaviour-unchanged is checked rather than asserted: `fingerprint` has one caller, is compared against a local `previous`, is never logged and never persisted, so the invariant is an equality relation inside one process and no stored digest can disagree. Deleting the separator reddens `id and detail ran together: the separator is not separating` |
| 4 | **Spend recording, specified and half-wired.** `seat_spend` (adds on conflict, because every seat reports more than once) and `metered_spend` (`NULL + NULL` stays `NULL` — an image call is not zero seconds of video), **no cost column in either**; `spendByVendor` groups by provider *then* adds, so no cross-vendor scalar exists anywhere; `spend.md`; a pricing footer on every terminal verdict; a three-legged contract-parity test | YES. Six mutations red, including `refusing to add openai tokens to anthropic tokens` (3 tests / 2 files) and `the scored verdict does not carry the pricing footer`. **One survivor, by construction** — see below |

#### THE SURVIVOR — lane 3's `egress` fix does not reach the record it claims to fix

`recordedNetworkPolicy(clause)` and `DASHBOARD_SANDBOX` are good work and are well
pinned: the recorded value is now `egress: "unrestricted-host-network (NOT a
measured denial)"` with an allow-list string that says there is no allow-list, the
function **cannot return `"denied"` at all** (a denial is a measurement the
bake-off earns with `--network none` plus a probe that must fail), and an empty
clause takes the unrestricted branch. **The write site is not pinned.** The
verification agent mutated `orchestrator.ts:1967` back to `networkPolicy: {egress:
"denied", allowedHosts: []}` and the suite stayed **GREEN at 850/848/0/2**.

It also measured — rather than inferred — that the site is live under test: a
side-effect marker there fires **23 times** per suite run and writes the honest
value to disk each time. So `run.json` **is** written, with that value in it, and
850/848 holds whatever the value says. **Nothing reads `run.json`** anywhere in
`dashboard/server/src` outside comments. The gap covers the **whole `heldConstants`
block** — `harness`, `imageRef`, `imageDigest`, `acceptanceSuiteSha256`,
`tokenAccountingRule` — not just `networkPolicy`. Recorded as §6 **instance 17**,
and deliberately not patched: fixing another lane's committed test inside a
verification pass is the "quietly fix it" this repo forbids.

Also dominated, and reported rather than repaired: `orchestrator.test.ts:1795`'s
`assert.deepEqual(DASHBOARD_SANDBOX.networkPolicy, recordedNetworkPolicy(sandbox?.network))`
**cannot be reddened by any mutation the line above it does not catch first**,
because `DASHBOARD_SANDBOX.networkPolicy` *is* `recordedNetworkPolicy(undefined)`.

#### What the fix wave did NOT do, in one place

- **Spend is not recorded.** The five writers — `recordSeatSpend` at
  `orchestrator.ts` 679 (spec), 680 (audit), 1101 (builder), 1643 (fix), 1952
  (judge), plus `recordMeteredSpend` and the terminal `writeRunSpend` — are named
  and unwritten, deliberately, as another wave's work. **The rule for writing them
  is recorded at the declaration site and is the interesting part:** record once
  per completed call or round, from the returned outcome, **never from a
  `BuildEventSink.tokens` callback** — that callback fires repeatedly with a total
  already cumulative *within* the call, so adding from it records
  T1+(T1+T2)+(T1+T2+T3) and inflates a run by a multiple.
- **`run.json`'s literal `totalCostUsd: 0`** at `orchestrator.ts:1835` is untouched:
  nulling it is a *contracts* change (`RunRecord.totalCostUsd` is `number` in
  `bakeoff/src/contracts.ts` and validated on read), and filling `usage` with
  `costUsd: 0` rows would be worse — `aggregate.ts` would then count real spend at
  zero.
- **No new SSE event** for spend: the emitter would have been a fifth declaration
  site for a channel with no writer and no reader.
- **`RunDetail` was not widened** for spend, because `http.ts:154` builds it as an
  object literal and a required field would not compile. The client mirror ships
  with no consumer, by the same precedent as `gateAttempts`/`gateStopReason`.

#### Method hazards this wave paid for — process, not measurement, and worth the lines

- **`git checkout -- <file>` destroyed a sibling lane's UNCOMMITTED work.** The
  verification agent used it to restore a mutation; the file reverted to HEAD and
  an entire uncommitted fix went with it. **Recovered provably** from that lane's
  own build artefacts: `.js`, `.d.ts`, `.js.map` **and** `.d.ts.map` all
  byte-identical after reconstruction — the `.d.ts` pair matters because `tsc`
  erases `import type`, so a `.js`-only comparison is blind to type-level edits;
  decoding the VLQ mappings is what located the original line layout. **The rule
  adopted mid-session: `git checkout --` only on committed files, Edit-based
  restore for dirty ones, and back every dirty file up first.**
- **`git commit -- <path>` is per-FILE, not per-hunk, so it swept another lane's
  in-progress work into `c0869ce`** (`orchestrator.ts` and `orchestrator.test.ts`
  hunks belonging to an egress/network-policy lane). Nothing was lost — it is in
  that commit — but anyone bisecting the `egress` field's history lands on a
  design-lock commit whose message never mentions it.
- **The calibration suite collides across agents.** `DEFAULT_CALIBRATION_RUN_ROOT`
  is a single shared directory, so a concurrent run inside it fails the other
  agent's suite (`mkdir '/scorer/out'` ENOENT, 8 subtests cancelled) and it reads
  exactly like a regression. **`DASHBOARD_CALIBRATION_ROOT` exists for this; every
  agent sharing this tree should set it** (§5 item 12).
- **Every absence claim in the wave used `grep -a` or node**, because
  `gate-fix-loop.ts` used to carry raw NUL bytes and `grep` silently skipped the
  file. That hazard is now gone at the source (lane 3), but the habit is the
  transferable part.

---

## 2. What was FIXED, and what each defect actually was

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
model picker enabled every subscription model, and the build then failed mid-run,
because builds strip that variable. In the other direction it is worse: the UI
promises "Included in your plan" over an identity billed per token.

This was **cross-module drift**. `bakeoff/src/subscription/claude-agent.ts`
already had the guard and the allowlist; `dashboard/server/src/auth.ts` was
written independently and had neither.

Fixed: both probes now run through `subscriptionSubprocessEnv` (the same
environment a build gets), and the Anthropic probe reads `authMethod` against
bakeoff's own exported `ANTHROPIC_SUBSCRIPTION_AUTH_METHODS` — **imported, not
re-spelled**. `api_key` is refused with a reason naming the billing. An
unrecognised method is also refused, naming the observed value, because the
failure direction here is silent spending. `models.ts` now spawns its catalog
probe with the same stripped environment; verified from the SDK's own source that
`options.env` **replaces** the child environment rather than merging over
`process.env` (`env: c = {...process.env}` is a *default*), so a deleted name
stays deleted.

Note which half of the fix does the work in which case. Stripping handles the
common one — a key in the shell. The `authMethod` check handles the one stripping
**cannot** reach: a key supplied by a Claude settings file or an `apiKeyHelper`,
which is not an environment variable and survives everything `subprocess-env.ts`
does. Neither half is redundant.

**EXECUTED**, four states against the real CLI:

```
A  real login, clean env                 -> OK       "authenticated subscription session"
B  empty CLAUDE_CONFIG_DIR, no key       -> MISSING  "Run `claude setup-token` in a terminal."
C  empty CLAUDE_CONFIG_DIR + junk key    -> MISSING  (was OK before the fix)
D  real login + junk key                 -> OK       (key stripped, subscription still found)
```

Plus 9 new unit tests (`auth.test.ts`) driving a stub CLI, including the `api_key`
rejection, the unrecognised-method rejection, a proof that the child process does
**not** receive the stripped names, and a check that no probe detail ever carries
the email, org id or org name the CLI prints.

### 2.2 The builder could read the held-out suite

See **§0**. Two mechanisms were added on the Anthropic driver on 2026-07-27 — the
permission callback and `sandbox.filesystem.denyRead` — a third (the policy tier)
landed on 2026-07-29, and the Codex gap was documented in the driver itself rather
than left to be found. **Do not read three mechanisms as three layers for a given
tool**; §0.2 gives the per-tool count.

This added a required field to `BuildRequest`. There is **exactly one**
construction site in the tree (confirmed by grepping `\.build\(` across
`server/src` including tests), so no other implementer was left silently
unprotected. **Superseded 2026-07-28:** the field is now `sealedRoots: readonly
string[]`, not `heldOutRoot: string`, and it carries two roots — the suite store
and `results/scorer-out`. The single construction site is `orchestrator.ts:580`.

### 2.3 Two persisted strings bypassed the redaction chokepoint

See §1.8, "Secrets".

### 2.4 The Agent tool was unguarded

`decideToolPermission` inspected only path-bearing tools, so an Agent call fell
through to `{behavior:"allow"}`. That permitted `isolation:"remote"` — running the
build off-host, outside the sandbox, `denyRead`, `allowWrite` and every path
check, with the workspace and ticket text leaving the machine — and left
`run_in_background` at its default of `true`, under which children keep writing
the workspace after the phase returns and the gate scores a moving artefact.

Closed before any delegation was built — or so this section said. The guard was
put in `canUseTool`, where the three conditions were correct and **never
consulted**.

**REWRITTEN 2026-07-29 (Phase 1.1). Everything after that first paragraph was
false, and it was false in the direction that matters: it described a boundary
that enforced nothing.** Both claims are measured wrong. The shortlist was NOT
empty — it has arrived on `BuildRequest.allowedAgents` since commit `4e05543`,
roughly two dozen names from `shortlistFor(classifySurface(ticket))`. And the
layer named as the enforcer does not run.

#### `canUseTool` is never consulted for the Agent tool

Probe A, both arms plus the `acceptEdits` arm from Phase 1: the callback returned
`{behavior:"deny"}` for the delegation, was consulted for **no tool at all**
(`denyConsulted=[]`), and `wordpress-master` started anyway — under `default`,
under `dontAsk`, under `acceptEdits`. An apparatus control in the same option
shape had `canUseTool` fire normally for `Write`, so "the callback is not wired"
is ruled out (`probes/results/A-default.json`, `A-dontAsk.json`,
`probes/results/raw/apparatus-canusetool-result.json`). There is no permission
mode that fixes it. All THREE conditions were vacuous, not just the shortlist —
the `isolation` guard and the `run_in_background` guard were dead in production
too, while the file header read as though they were boundaries.

The branch is **deleted** rather than left as documentation. A `PreToolUse` hook
now carries the same three conditions; it REPLACES those guards, it does not
supplement them. The SDK points here itself — `sdk.mjs`'s shadow-warning text
reads *"To gate every tool call, use a PreToolUse hook instead."*

#### `SendMessage` — the shortlist bounds WHICH AGENTS EXIST, not HOW MUCH WORK THEY RECEIVE

Measured by probe H, four arms of one live session (`probes/results/H.json`). The
hook fires for `SendMessage` too, with `tool_name: "SendMessage"` and `tool_input`
keys `to, summary, message, type, recipient, content` — **`subagent_type` absent
in every firing**. So the delegation guard returned `{continue: true}` **by
construction**: nothing in the call looked like a delegation, because starting an
agent and feeding one are different calls. In the SAME session that denied a
`wordpress-master` spawn — so the guard was demonstrably armed — `SendMessage`
resumed `code-reviewer` and produced a second `task_started` plus a
`SubagentStart` carrying orchestrator instructions no shortlist rule ever saw.

**Static evidence, read off the bundled CLI's strings rather than observed at
runtime** (`H.json`'s own `staticEvidence` block, and kept in that category): the
tool's permission check self-permits —
`async checkPermissions(e,t){return{behavior:"allow",updatedInput:e}}` — and
`backfillObservableInput` MUTATES `tool_input` in place, adding
`type`/`recipient`/`content`. The second has a live consequence: the guard's shape
test has to be a SUBSET test, because "exactly the three schema keys" would be
green in a unit test and open in production. **It also carries an unmeasured
over-deny.** Which OTHER tools get `content` backfilled is unknown. If the
backfill is wide, a tool whose real schema is `{from, to}` — a move or a copy —
arrives carrying a body and is denied here. The unit tests pass RAW inputs, so
they cannot see it. It fails in the safe direction and the denial names itself in
the transcript: **if a build is ever refused a move, this paragraph is why**, and
the fix is to require a body key the backfill does not add.

**The fix is outright denial**, and that is the best a `PreToolUse` hook can do
rather than a lazy choice. Validating a resume means checking the target against
the agents this run actually started — and the agentId appears ONLY in the Agent
tool's RESULT, which `PreToolUse` never sees. A hook inspecting `to` would be
judging a display name against nothing: the shape of check this phase exists to
delete, not to add. The cost is small and real: an orchestrator that wants more
from an agent starts another one and puts everything in that call's own prompt.

One thing probe H did NOT establish, recorded so it is not credited to us:
`SendMessage` never reached an agent the shortlist had denied, but that refusal
came from the CLI's own roster resolution ("No agent named … is reachable"), which
is not the shortlist (`probes/results/H2-DENIED-TARGET.json`).

#### `Options.agents` DOES NOT BIND — and the roster will tell you it did

Probe I, three live sessions, three field pairs, each with a negative control in
the same session (`probes/results/I.json`). For a name that ALSO exists in
`~/.claude/agents/`, the on-disk definition wins and the `Options` entry leaves no
observable trace on the child:

- **prompt** — the on-disk `code-reviewer` ignored our nonce; a fresh name
  (`zzz-probe-only-agent`), registered identically and existing only in
  `Options.agents`, echoed it. The definition channel demonstrably works in that
  very session.
- **model** — same split, independent of the prompt: the fresh child ran on
  `claude-haiku-4-5-20251001` (our definition), the colliding name on
  `claude-opus-5[1m]` (the model named in `code-reviewer.md`).
- **maxTurns** — `maxTurns: 1` cut the fresh child off after one round-trip and
  was DROPPED for the colliding name, which took 2 turns to read a file and report
  it.

**All 26 shortlisted agents exist in `~/.claude/agents/`**, and the hook denies
everything off the shortlist, so the per-agent block was not merely inert — it was
**unreachable**. It has been deleted, along with the report contract that rode on
`AgentDefinition.prompt`. The contract itself survives, and it survives on a
channel that was measured to work: in probe I's S2 session (`s2.delegations[1]`)
the on-disk `code-reviewer` — the child whose definition was discarded, running
the disk model — followed an instruction present ONLY in the Agent call's own
`prompt` argument, read the file that instruction named, and returned its contents
(`SEED-I-8HXQ2P5L-ONDISK-WV4M`, `toolNames: ["Read"]` in the child's own
transcript). The per-call prompt reaches a child that the `AgentDefinition` does
not. Nothing checks that the orchestrator actually pastes the contract into a
call, and nothing truncates a subagent that narrates anyway — it is an
instruction, not a boundary, and it is written down here as one.

**THE VERIFICATION TRAP, which is the part that will catch the next reader.**
`supportedAgents()` advertises the `Options` entry — our description, our model —
and `getContextUsage().agents[]` sources it to `flagSettings`, while the engine
runs the disk definition. The init roster lists `code-reviewer` **twice**: the
disk entry and the `Options` entry coexist under one name. A check that stops at
the roster concludes the definition bound. It did not.

**`AgentDefinition.background` is inert for EVERYONE**, and that is a separate
finding rather than a consequence of the collision: `background: false` failed to
hold even for the fresh name whose `model` field demonstrably bound in the same
delegation — both came back `status: async_launched` with
`background_tasks_changed` reporting them live. It is a per-FIELD no-op. **This
deserves its own probe**: n=1 per arm, one model, SDK 0.3.220, and if `background`
is genuinely unhonourable then "a detached child cannot keep writing the workspace
after the phase returns" rests entirely on the hook's `run_in_background !==
false` denial and on nothing structural.

---

## 3. NOT PROVEN — untested, open, unmeasured, and not covered

Nothing in §3.1 has been observed working. **Do not describe any of it as
working.**

### 3.1 Untested — no credentials, or it would cost quota

- **A complete Codex build.** `codex login status` reports "Not logged in" on this
  machine. The whole OpenAI path — thread start, event mapping, usage merge,
  rate-limit detection, resume — has never run against a real session.
- **`rate_limited` as a terminal state from a real rejection.** Only
  `allowed_warning` events have ever been observed.
- ~~**Resume actually continuing a provider session.**~~ **CORRECTED 2026-07-30 —
  this is no longer unverified.** §1.0's run built in **two segments and they
  resumed ONE session**, established four independent ways, of which the one worth
  naming is that the **token totals SUM exactly rather than max** — a check that
  would have observed the opposite outcome had the second segment started a fresh
  conversation. **REPORTED**: the establishing artefacts were not read by this
  pass, only the score record was. What is still unverified is resume across a
  *restart of this server* and resume on the Codex path.
- **Cancel of a live build.** Cancel of a *queued* run is tested.
- **`deploy: true` through the full pipeline.** `PreviewHost` is unit-tested
  alone.
- **The judge seat against a real model.** Its parsing is tested against
  fixtures.
- **`DEFAULT_SEAT_CALL_MAX_TURNS = 8`** is a measured floor from one suite, not a
  bound. `DASHBOARD_SEAT_MAX_TURNS` raises it and is named in the failure text.
- **Every named Codex model id.** The dashboard asserts only `codex-default`
  ("whatever the CLI is configured to use"). Anything in
  `DASHBOARD_CODEX_MODELS` is your assertion, not the dashboard's.

### 3.2 Still OPEN — bypasses of the sealed-root scan, measured against `dist`

- **NEW 2026-07-30, and it is not a bypass of the scan — it is a readable copy of
  the held-out titles OUTSIDE every root the scan is given.** Found while reading
  §1.0's score record, and stated as a **path-coverage** claim because this pass
  could not execute anything:
  - The three Anthropic layers all derive from **one list**. `claude-builder.ts:749`
    canonicalises `request.sealedRoots` and that same array feeds the `canUseTool`
    scan (`:769`), the policy-tier `permissions.deny` (`:964`) and the OS sandbox's
    `denyRead`. The list is built at `orchestrator.ts:1179-1186` and again for the
    fix round at `:1750`: **`[paths.acceptance, scorerOutRoot(paths)]`**, where
    `scorerOutRoot` is `join(paths.results, "scorer-out")` (`gate-attempts.ts:37`).
  - **The `ScoreRecord` is not written there.** `bakeoff/src/scorer.ts:1039` writes
    it to `join(resultsDir, "scores", "<runId>.json")` — a **sibling** of
    `scorer-out`, not a child — with the container log beside it at
    `:1201`. So `dashboard/results/scores/` is named by no deny rule, no policy
    rule and no sandbox clause.
  - **And that file carries held-out test titles verbatim.** Read out of §1.0's
    record: `evidenceRef` values such as `holdout/coglane-booking.spec.mjs ›
    [REQ-009] T-10 submitting the booking form shows a confirmation that was not on
    the page before`, on every criterion, plus a `detail` naming the failing
    held-out test.
  - **The concrete reader is the fix agent**, which gets the same `sealedRoots`
    (`orchestrator.ts:1750`) and runs *after* the gate has written the score. It is
    handed tier-and-count only, on purpose (`fix-prompt.ts:96-102`: *"Which criteria
    those are, and what they assert, is the measurement — it is not something I can
    tell you"*), and a path that answers exactly that question sits one directory
    over from the root that was sealed to prevent it.
  - **This is the 2026-07-28 class reopened in a new directory.** The rule is
    written in the tree already, at `gate-attempts.ts:20-26`: *"`results/scorer-out`
    is passed to every builder as a `sealedRoot` … because `result.json` carries
    `criterionCoverage[].testRefs` — held-out TEST TITLES. … Anywhere outside the
    sealed root and the loop would have quietly created a readable copy of the
    held-out suite's identities."* `results/scores/<runId>.json` **is** that copy.
  - **UNVERIFIED:** that a build actually reads it. No read was attempted — this
    pass had no shell, and §1.0's run attempted no sealed read of any kind. What is
    verified is the path coverage, from three files. **Not a committed leak:** the
    repo-root `.gitignore` ignores `dashboard/results/` wholesale, so this is an
    on-disk exposure to a same-UID process, exactly as the `scorer-out` case was
    before it was closed.
  - **The cheap fix is one array element** — add `join(paths.results, "scores")`,
    or seal `paths.results` and let the sub-roots inherit. Not done here: this pass
    could not run the negative control that would prove it (deny fires, ordinary
    work still allowed), and a boundary edit whose removal proof was never executed
    is what §6 is about.

- **A sealed path EMBEDDED in shell or code text under a non-exempt key is
  allowed.** Measured 2026-07-28, not reasoned about:
  `Monitor{command:"cat <suite>/t.mjs"}`, `Monitor{cmd:"cat <suite>/t.mjs"}` and
  `REPL{src:"read('<suite>/t.mjs')"}` all return ALLOW. A non-exempt string is
  judged WHOLE, so `"cat /tmp/dash/acceptance/t.mjs"` resolves to
  `<workspace>/cat /tmp/…`, which is neither the suite nor an ancestor of it. What
  the third pass DID close is the same tool carrying a BARE sealed path
  (`Monitor{command:"<suite>/t.mjs"}` now denies). **The Phase 0.2 plan header
  listed this bypass as closed by that change. It is not, and the plan was wrong
  about it** — its own task text asserted on the bare-path form. Closing the
  embedded form means pulling path-like TOKENS out of free-form text, which is a
  text filter rather than a boundary: `acc''eptance`, `$HOME/../dash/…` and
  `cd <suite>; cat t.mjs` all step around it while it reads like a boundary in a
  table. The layer that actually covers text-executing tools is the OS sandbox's
  `denyRead` — **exercised as of 2026-07-29** — so this is less bad than it was,
  though the residue is unchanged: an out-of-process `mcp__*` server has no such
  layer at all, and the MCP surface is removed from a build for exactly that
  reason. `Bash{command:…}` is in the same position and is exempt deliberately:
  `autoAllowBashIfSandboxed` means a sandboxed Bash never reaches the callback
  anyway. **Do not "fix" `Bash{command:"cat <suite>/t.mjs"}` here** — scanning its
  command string would deny ordinary work while buying nothing.
- **The walker's node budget can be starved.** `NODE_BUDGET` is 512 nodes, spent
  and not restored, so once it runs out later siblings are never scanned. Measured
  against `dist`: `{pad:[…600 zeroes…], evil:{file_path:"<suite>/x"}}` returns
  ALLOW. The budget replaced a depth cap that was worse (eight `{nest:…}` levels
  sufficed), and any finite bound has this property — an unbounded walk over
  attacker-shaped input is a denial of service and would not terminate on a cyclic
  object. Narrowing it (charge only CONTAINER nodes, or walk breadth-first so
  shallow keys are never starved by a deep sibling) is the real fix and is not
  done. Padding to 512 nodes is at least conspicuous in a transcript in a way a
  seventh `{nest:…}` was not.
- **Case-folding over-denies on a case-sensitive volume.** A genuinely distinct
  `/x/ACCEPTANCE` would be denied alongside `/x/acceptance`. Deliberate: the safe
  direction for a sealed root.
- **Whether the sealed-root scan in `canUseTool` fires for a `Read`/`Grep` issued
  by a SUBAGENT rather than the orchestrator is UNVERIFIED.** Inferred from the
  SDK's `agentID` plumbing and corroborated by
  `SDKPermissionDeniedMessage.agent_id`, never observed. Corrected 2026-07-29: the
  sentence this bullet used to end with — "the Agent-tool guard of §2.4 is proven
  only as a pure function" — was **generous**. That guard was not merely unproven
  as wiring, it was never called, and it has been deleted. What remains matters
  less than it did, because the policy-tier rule needs no callback and applies to
  the session.

### 3.3 Resolved, kept for the history

- ~~**`sandbox.filesystem.denyRead` is ENFORCED BY NOBODY WE HAVE OBSERVED.**~~
  **RESOLVED 2026-07-29 — moved to §0.** Corrected three times, and the history is
  worth keeping. It first said "the value reaches the CLI", which was an
  overclaim: `src/builders/settings-plumbing.test.ts` constructs its OWN `Options`
  literal with its own local `heldOutRoot` and asserts that same local variable
  round-trips into the `--settings` payload — a property of the SDK, not of this
  codebase, and it never invokes `ClaudeSubscriptionBuilder`. On 2026-07-28 the
  builder's half became tested. On 2026-07-29 the OS side was observed: a
  sandboxed `cat` refused with `Operation not permitted`, and still refused with
  the policy rule emptied. Bash is covered twice, independently.
- ~~**Whether `denyRead` covers in-process tools is UNRESOLVED.**~~ **RESOLVED
  2026-07-29: it does NOT.** Phase 1 measured `denyRead` alone leaving the
  in-process `Read` tool free, which matches the typings scoping filesystem
  clauses to "within the sandbox"/"sandboxed commands". So `Read` has exactly one
  layer — the policy-tier deny rule — and the Phase 0.5 canary probe this bullet
  used to defer to was never needed for this question.
- ~~**The wiring is a source-shape assertion.**~~ **Corrected 2026-07-28.** It
  was, and that was worse than no test (§6 instance 2). `buildOptions(request,
  allowUnsandboxed)` is now an exported seam and the returned object is asserted
  directly; all five disconnection mutations kill at least one test each (§1.1).
  **What this does NOT prove:** that the CLI honours `denyRead`, or that
  `canUseTool` fires for subagent-originated calls. Unit tests prove the predicate
  and this codebase's wiring of it; they say nothing about the CLI's behaviour on
  the far side of that seam. A test driving `ClaudeSubscriptionBuilder` against a
  stub executable would be stronger still. **Half-answered 2026-07-29:** the far
  side is now measured by live runs for `denyRead` and the policy rule (§0), and
  the subagent-origination question turned out to be the wrong one to ask — for the
  tool that spawns subagents, `canUseTool` is not consulted at all.

### 3.4 UNMEASURED, and not to be laundered into "should hold"

Every item here was reachable by an experiment somebody chose not to run, or by
one this environment cannot run. None of it may be written up as covered.

- **`isolation: "remote"`.** Denied by construction, never measured — it is
  availability-gated and runs off-host, so there was nothing here to observe it
  with. `isolation: "worktree"` IS measured, against a real git-repo fixture so a
  worktree failure could not be mistaken for a hook effect; the denied call came
  back with the hook's verbatim reason rather than a git error.
- **`allowManagedHooksOnly: true` composed with the background / absent-flag /
  selective-policy arms.** Probe E measured the lock for FOREGROUND delegation
  only. Composing the two is an inference — a reasonable one, since the lock gates
  WHETHER programmatic hooks run at all rather than per-tool shape — and an
  inference is what it stays until somebody runs it.
- **Permission modes other than `acceptEdits`** for the hook. Probe A covered
  `default` and `dontAsk` for the *callback*; the hook was measured under
  `acceptEdits`, which is what production sets.
- **Whether `Options.agents.prompt` reaches ANY child.** Both children in probe
  I's DoD-3 arm reported no critical system reminder — including the one with no
  disk file, whose `model` field demonstrably bound. So `oursInForce=false` is
  equally consistent with "the disk definition overrode ours" and "prompt/reminder
  fields are not observable through self-report". **No positive control fired for
  that channel**, which is why the nonce in the reply body — not the reminder — is
  what probe I's verdict rests on.
- **The third start-observable never went positive anywhere.** `startedFor()`
  watches three channels; every subagent in every arm ran with `tool_uses: 0`, so
  the third never fired even for agents that demonstrably started. **Read every
  deny as TWO demonstrated channels going silent, not three.**
- **Whether `AgentDefinition.disallowedTools` does anything.** Probe G2 measured a
  per-agent `disallowedTools: ["mcp__*"]` child at 620 tools, 589 of them `mcp__`
  — identical to an unnarrowed child (`probes/results/G-PERAGENT.json`). Probe G3
  then removed that field and the narrowed child stayed at 28 tools with zero
  `mcp__` (`G3-PERAGENT-REMOVED.json`), so the work is being done by the
  SESSION-level `allowedMcpServers: []` lock. Which of the two narrowings does what
  was not separated by any single run, and the per-agent one is now deleted along
  with the rest of the block.
- **A type error caught by `GATE:build`.** See §1.9's open table.
- **Substance.** Nothing in the tree measures whether a build says anything
  (§1.4c, §1.7).

### 3.5 WHAT THIS FILE DOES NOT COVER — FIVE lanes that landed after its last measurement

**New 2026-07-30, and it is the most important addition of that pass.** The
modules below are **present in the tree** — verified by `Glob`/`Grep`, which is
all a shell-less pass can verify. **There is no measurement of any of them in this
file, and nothing here may be read as saying they work** — read that sentence with
the narrowing immediately below it, which was added hours later and moves four
specific seams out from under it and nothing else. Their plans are the
nearest thing to a record until somebody measures them and writes it up.

**PARTLY SUPERSEDED THE SAME DAY, and only partly — read the narrowing
carefully.** §1.10 measures **four specific seams** inside these lanes and nothing
else: 2b's design lock (a click now locks a run, red at both layers), 2c's trigger
(the `animate` mark in the manifest template the design agent copies, pinned by a
plan rather than a grep), 2b's image counting (by file signature, not by
extension), and 2b/2c's five real published stills from §1.0's run. **Everything
else in the table below remains unmeasured** — the anti-slop hooks, the canvas, the
whole cron lane, and every seam of 2b/2c that is not one of those four. A lane with
one measured seam is not a measured lane.

**How the mapping was made, because guessing it would be the §1.6 defect one
level up:** every module below was confirmed present by `Glob`, and the lane
attribution for `graph.ts` / `graph-emit.ts` was read off the canvas plan's own
file list (`2026-07-29-phase-3-canvas.md:125,147,152,165,299`). The rest is
inferred from path and from what each test file imports — **inferred, not read off
a plan's file list**, and marked so.

| lane | modules in the tree (`dashboard/server/src/`) | plan |
|---|---|---|
| 2a anti-slop hooks | `builders/antislop-hook.ts`, `builders/antislop-rules.ts` (+2 test files). `decideMotion` and `makeMotionStopHook` live here, not under `design/` | `docs/superpowers/plans/2026-07-29-phase-2a-antislop-hooks.md` |
| 2b design lane | `design-lane.ts`, `design-manifest.ts`, `design-prompt.ts`, `design-lock.ts`, `design-env.ts`, `design-outcome.ts`, `design-capability.ts` (+7 test files). The `RunDetail` contract already carries a DESIGN-lane lock (`api-types.ts:209-213`) | `2026-07-29-phase-2b-design-lane.md` |
| 2c image-to-video | `design/video-capability.ts`, `design/video-legs.ts`, `design/video-lane.ts` (+3 test files) and `gemini-video-harness.mjs`. **`design/motion-staging.ts` does not exist** — `design/motion-staging.test.ts` is a test with no module of its own, and it tests 2a's `builders/antislop-*` (§6 instance 13) | `2026-07-29-phase-2c-image-to-video.md` |
| 3 canvas | `graph.ts`, `graph-emit.ts` (**read off the plan**); UI under `dashboard/src/components/canvas/`; `dashboard/tests/canvas-edges.browser.spec.ts` | `2026-07-29-phase-3-canvas.md` |
| 4 cron | ~~**NOTHING IN THE TREE YET.**~~ **LANDED — corrected later on 2026-07-30, hours after the row was written.** `Glob`: **14 files** under `dashboard/server/src/cron/` — `cron-config`, `cron-journal`, `cron-lease`, `cron-policy`, `cron-queue`, `cron-report`, `cron-tick`, each with its own test — plus both of the plan's named `Create` targets, `dashboard-url.ts` (+ its test) and `cron/cron-lease.ts`. **Still unmeasured here**, and it carries two of the stale comments in §1.9's open table (`cron-tick.ts:329`, `cron-tick.test.ts:258`). The original row is kept because it dates how fast this tree moves: a lane went from absent to fourteen files inside one day | `2026-07-29-phase-4-cron.md` |

Also present and unmeasured here: `adversary.ts`, `agent-shortlist.ts`,
`gate-attempts.ts`, `contract-parity.test.ts`, `security.test.ts`,
`build-segment.ts`, `tokens.ts`, `surface.ts`.

Two things about these lanes ARE recorded, and both are defects rather than
capabilities: §6 instance 10 (the canvas reduced-motion specs emulated nothing)
and §6 instances 13 and 14 (the video lane's motion-staging test and its download
fixture). A lane whose only appearance in the status file is in the defect table
has not been assessed; it has been sampled.

---

## 4. REPORTED by a module author, not re-verified here

Recorded as their word. Where it matters, it is worth re-running yourself.

- **SUPERSEDED 2026-07-30 by §1.0, which is better evidence of the same claim: a
  real end-to-end run whose score record this file read directly, on a non-trivial
  ticket, with a failure in it.** The bullet stays for two reasons — it is a second,
  independent completion, and its caveat is the instructive part. As originally
  written: a **full pipeline run end to end against the real subscription** (trivial
  static ticket, `sonnet`): spec → build → gate → judge, `heldOutPass=true`,
  `falseFinish=false`, `costUsd=null`, REQ-001..012 all pass, 3 screenshots. **Not
  reproduced here** — it costs quota. **That run predates 2026-07-28, so its
  `heldOutPass=true` was produced under the boundary with the executed bypass and
  cannot be verified retrospectively — see §0.3.** The rest of the bullet (that
  the pipeline completes end to end) is unaffected.
- That the spec seat runs **with no API key**, `assertUnused()` confirming the base
  HTTP client never dispatched, and that `jsonSchema` is applied rather than
  dropped. The two tests that would prove it are the two skipped by default.
- The bake-off blocker fixes D1 (node:test second pass) and D2 (static artefacts),
  and the `bakeoff/STATUS.md` §1.4 REQ-id attribution fix. **Their evidence was
  re-run** — dry run, `scorer-modes.e2e`, all four smoke suites — and it all
  passed, so these are better supported than "reported". What was not re-derived
  is the reasoning behind each design choice.
- The UI author's 49 Playwright checks. A subset (the no-credential path) was
  re-run and matched.

---

## 5. Before your first real run — checklist

1. **`claude setup-token`**, and **`codex login`** if you want the OpenAI arm.
   `/api/health` must show both `ok` before a run of that provider will start.
2. **Build `bakeoff` first** (`npm install && npm run build`). The server imports
   `bakeoff/dist/*.js`; an uncompiled tree fails at startup with a
   module-resolution error, not with advice.
3. **Build the scorer image with `--provenance=false --sbom=false`.** Without
   those flags BuildKit's attestation moves the digest on every rebuild from an
   identical context, and the digest recorded in every score certifies nothing.
   **Then re-resolve and pin it** after your last edit to `bakeoff/src` — any
   source edit moves it, because stage 1 of the Dockerfile compiles `src/`.
   `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'`. **Resolve it, do
   not read it from §1.2.** If the value you resolve is not §1.2's last row,
   something rebuilt the image and every score record on the other side of that
   rebuild belongs to a different held-constant world.
4. **Re-run `npm run bakeoff -- dry-run` against the image you just pinned.**
   **UPDATED 2026-07-30 and still not closed.** The 24/24 green in §1.3 was
   measured on 2026-07-27 against `1c06aa11…`. A second dry run is now recorded —
   GREEN, alongside §1.0 — but the score record pins that run to `c98bad3a…` and
   **the image moved again the same day** (§1.2, move #4). So a dry run exists
   against a *superseded* image, which is progress and is not this item. The
   assertion to watch is *"the gate PASSES an honest artefact"*: a gate that can
   never pass is indistinguishable, in a final report, from every model failing.
5. **Read §0.** Decide whether a `heldOutPass` from this tool means what you want
   it to mean, particularly on the Codex path where the read boundary is absent.
   Any `heldOutPass` in your existing data that predates 2026-07-28 is unverified
   (§0.3), and there is no way to recover the answer after the fact.
6. **Delegation is allowed, but only to this run's shortlist, and `SendMessage` is
   denied outright.** Corrected 2026-07-29: this item used to say delegation was
   denied outright because the shortlist was empty. It has not been empty since
   `4e05543`. A build may delegate to roughly two dozen agents chosen by
   `shortlistFor(classifySurface(ticket))`; anything else is refused by a
   `PreToolUse` hook with a message naming the permitted agents, and a resume via
   `SendMessage` is refused whoever it is addressed to. If a build reports it could
   not delegate, that is why — not a credential or a network fault. An EMPTY
   shortlist still denies everything, and that remains the fail-closed default. See
   §2.4, and read §0.4 before treating this as a boundary of the same strength as
   the sealed suite.
7. **Do not paste a secret into a ticket.** The ticket text is sent to the provider
   verbatim, because it is the prompt. On-disk copies are redacted; that is a
   second line of defence, not the first.
8. Expect a **429**. It is a rolling 5-hour window plus a weekly cap, it is a
   normal state, and the run resumes.
9. The first run of a ticket authors and freezes a suite. That costs quota before
   any building happens, and a suite authored under an older prompt is not
   re-authored automatically.
10. **If you are about to add a check, read §6 first.** **Seventeen** checks in
    this repo have shipped green over something that did nothing — three added
    2026-07-30, one of them the fix wave's own. The pattern is cheap to repeat and
    expensive to find.
11. **Do not trust this file about the lanes in §3.5**, and do not read a number
    here as current: the newest count it watched itself is 281 tests, the newest it
    has been told is **850** (§1.1), and that figure was already the third
    "current" baseline of the day.
12. **If you run tests while another agent shares this tree, set
    `DASHBOARD_CALIBRATION_ROOT` to your own scratch directory.**
    `DEFAULT_CALIBRATION_RUN_ROOT` is shared, and a concurrent run inside it fails
    *your* suite with `ENOENT: mkdir '/scorer/out'` and cancelled subtests — which
    reads exactly like a regression you caused (§1.10).
13. **Do not expect the run record to tell you what a run cost.** Not in dollars
    (by construction, §1.8) and **not in tokens either**: the spend tables landed
    without their five writers (§1.10). A 1 h 44 m run leaves no spend row. It
    fails honestly — the empty branch refuses to render a total rather than
    printing a zero — and it still leaves you blind between quota checks.
14. **Treat `dashboard/results/` as sealed material, not as output.**
    `results/scores/<runId>.json` carries held-out test titles verbatim and is
    covered by none of the three deny layers (§3.2). Until that array gains one
    element, do not point anything at that directory, and delete a ticket's score
    records before re-running the same ticket.
15. **Do not read "the visible suite passed" into any run on this path.** It cannot
    be executed here — the OS sandbox refuses `listen` on 127.0.0.1 (§1.0), so the
    visible half is a read-only signal for the builder. Only the sealed gate's
    result is an execution result.

For the **campaign** path — prices, config E, the four-arm matrix — the checklist
is `bakeoff/STATUS.md` §8. Items 3, 4 and 5 above are the shared ones; they live
here and are cross-referenced there.

---

## 6. The defect this repo keeps shipping — SEVENTEEN instances, and counting

One shape accounts for every false green this project has produced: **a check
that can only observe success.**

**THE RULE, and it is cheap:** every check must be shown, in the same run, to be
able to observe the OPPOSITE outcome. For a probe, that is a negative control in
the same session. For a boundary, it is REMOVAL — delete the layer, watch the
boundary fail, put it back. Every 2026-07-29 claim in §0 carries one; the older
EXECUTED rows mostly do not, and that is a real difference in strength between
them.

**Four things the table adds to that rule, each learned the expensive way:**

1. **Knowing the shape is not sufficient — only running the mutation is.**
   Instances 8 and 9 were added the same day the table was written, by an
   adversarial pass over the phase that wrote it.
2. **A check whose failure mode is a strict subset of another check's is not a
   second check.** Instances 8 and 9 WERE capable of failing — but only in
   circumstances that would already have turned a louder check red. The test:
   break the thing THIS check is supposed to see, and confirm it fails ALONE.
3. **Verify the emulation you asked for actually took effect.** Instance 10 was
   written CORRECTLY against the API its author believed existed, and the runtime
   silently accepted an option it no longer honoured. No test failed, no warning
   printed, and only the type-checker knew. A dependency can turn a live check
   into decoration between one minor version and the next without touching your
   code.

4. **A headline inequality can survive every half-patch.** New 2026-07-30. A
   control asserting *"the two shapes must genuinely differ, or nothing is
   wired"* (`notStrictEqual`) was written as the first line of a test precisely so
   it could not be vacuous — and the verification pass found it **green when
   `designLock` alone was dropped AND green when `interactive` alone was
   dropped**; the discriminators were the two equality assertions below it. Both
   halves had to be mutated separately to pin them. "Put the inequality first" is
   right and it is **not sufficient**: an aggregate assertion cannot see a partial
   revert of the thing it aggregates.

Instances 2, 3, 6, 7, 13 and 17 share a sharper sub-shape worth naming on its own:
**the assertion and the production path were never connected.** A test that calls
a function directly can never tell you the loop still calls it. A seam helps read
the code; it does not make the call site load-bearing.

| # | The check | What it could not see |
|---|---|---|
| 1 | The **16-probe review** of the sealed boundary | It exercised only the vectors its own author designed for, and reported 16/16. A later adversarial pass walked through `Grep{path:<ancestor-of-suite>}` (§0). Whether that exact vector was among the 16 is not recorded; what is recorded is that the review's coverage was measured against its own author's imagination, which is why 16/16 meant nothing. |
| 2 | The **source-text "wiring" test** | It matched regexes against `claude-builder.ts`'s own SOURCE. `canUseTool` deleted, `denyRead` emptied, `allowWrite` widened to `/`, sandbox off — the suite stayed green at 76/74/0 through all four. |
| 3 | **`settings-plumbing.test.ts`** | It constructs its OWN `Options` literal, then asserts that same local variable round-trips into the `--settings` payload. It never calls the builder. It is a test of `JSON.stringify`. **Still in the tree**, still green, and still proves nothing about this codebase. |
| 4 | **Probes C and D**, as the plan wrote them | `positive: true` and `negativeControl: true` shipped as HARDCODED LITERALS, each justified by a comment. Probe C's run declared no non-managed hook at all, so its "user hooks were suppressed" was a constant. Fixed with a real project-tier fixture hook and a byte-identical paired control. |
| 5 | **The probe harness's own exit code** | The gate keyed on `notes.startsWith("INCONCLUSIVE:")` alone, so a plain `FAIL` exited **0**. Run 1 recorded three FAILs — including the probe gating the whole approach — and exited 0. This was the defect the harness was built to prevent, sitting inside the harness. |
| 6 | **The Task 5 token seam** | The per-model fix was reverted at its SOLE production call site and the suite stayed byte-identical at 200/198/0/2 — every assertion lived where the function was called directly. The arithmetic was then lifted into a seam and pinned by five tests; an auditor reverted the CALL SITE and the suite stayed green at 229/227/0/2. **The seam moved the hole one line; it did not close it.** What closes it is driving `build()` with synthetic envelopes and reading the sink. |
| 7 | **A test pinning `AgentBounds.effort`** | It asserted a field that was `null` for all 26 agents, whose only reader was a conditional spread into `AgentDefinition.effort` — a route probe I measured does not bind for any name this run can delegate to. Green forever, over a mechanism that does nothing. Deleted 2026-07-29 with the route. |
| 8 | **The calibration FALSE-PASS test** — `calibration.test.ts`, "no fixture produces a FALSE PASS" | It looped `MUST_FAIL` asserting `outcome === "fail"`. Every `MUST_FAIL` fixture has `expected: "fail"`, which the test ABOVE it already asserts for every fixture — so it was **logically implied and could not fail unless that one already had**. Emptying `MUST_FAIL` (`.slice(0, 0)`, fixtures untouched) left the whole gate **green at 7/7, exit 0**. It survived an adversarial pass of 28 mutations in which 26 went red. Worse: `fixtures.ts` claimed in its header that the false-pass direction was asserted "SEPARATELY and more loudly than overall accuracy" — **a false claim sitting inside the file that documents this very defect.** Closed 2026-07-29: the test now asserts its own derivation and `heldOutPass === false`; re-run under the same mutation it fails ALONE, 1 of 7. **Both new clauses were mutated separately** — M4 empties `MUST_FAIL`, M5 hardcodes `heldOutPass: true` (§1.4a) — because a fix proved by one mutation leaves the other clause exactly as unproven as the thing being fixed. |
| 9 | **Two held-out-leak assertions in `run-report.test.ts`** | `assert.doesNotMatch(verdict, HELD_OUT_TITLE)` and the `holdout test T-2` twin, over `verdict.md`. That run never reaches the gate, so the file is the **no-verdict page, which prints no criterion prose at all** — there is nothing for a criterion-borne leak to ride in on. MEASURED: rendering that page from criteria whose statements carried both markers gives 807 bytes containing neither; the same criteria marked scored give 1879 bytes containing both. The `forAssumptions` blanking of `evidenceRequired` is the same shape — passing the field through leaves all ten tests green, because `ApiCriterion` **has no such field**. Milder than the others and said so: the boundary IS proven, by the `assumptions.md` twins (red under a `#recordCriteria` mutation) and by `verdict.test.ts` against `detail`/`evidenceRef`. Relabelled at the assertion site 2026-07-29, not deleted — they go live the day the run reaches the gate. |
| 10 | **The reduced-motion specs written to PREVENT instance ten** — `dashboard/tests/canvas-edges.browser.spec.ts` | They declared `test.use({ reducedMotion: "reduce" })`. **Playwright 1.62 dropped `reducedMotion` as a top-level fixture; it belongs inside `contextOptions`.** The bare key is accepted at runtime and **emulates nothing**, so every spec below it ran the browser in its DEFAULT motion state while asserting the reduced-motion rule — a suite that would have gone green whether or not the rule existed. Caught by `npm run typecheck`, not by the tests, and caught *inside the file written to keep the canvas honest about motion*. Fixed at `canvas-edges.browser.spec.ts:154`; the paired negative control at :122 proves the dash disappears only under emulation. **The lesson is the flag's, not the author's.** |
| 11 | **`auditSuite`'s `ticketBrief` argument** — `bakeoff/src/spec-agent.ts` | The option existed, the rule read it, and **the caller never passed it** — though `DeterministicAuditOptions`' own docblock named the caller, the file and the exact line to write: "`auditSuite` in spec-agent.ts already holds the `Ticket` and should pass `ticketBrief: ticket.brief`." Nothing was red, because the prose-floor rule fires with or without the brief **by design** — a rule that disarms itself on a missing optional input is instances 1-10 pointing the other way. So the safe default hid the dead seam. What was lost was not detection but FEEDBACK: with the brief the seat is told ", and the ticket never states 200"; without it, only the generic sentence — and that clause is the entire argument for the rule being BLOCKING, since `mustRegenerate` buys another authoring call and is worth it only if the re-author is told something the last one was not. **The expensive half of the rule was paying for the cheap half's message.** Sub-shape of 2/3/6/7 with a twist: there was no wrong assertion, there was NO assertion. Closed by testing the SEAM through `auditSuite`, not the rule. |
| 12 | **`GATE:screenshots-present`** — `bakeoff/src/scorer-container.ts:694` | Its name and its own detail string say "a masked, **non-blank** screenshot exists for every declared flow". `nonBlank` is `bytes.byteLength >= MIN_SCREENSHOT_BYTES`, and `MIN_SCREENSHOT_BYTES` is **1024** (`scorer-protocol.ts:809` — re-read 2026-07-30, still 1024, still unfixed). MEASURED across 57 captures: `blank-page` renders 2541 / 4468 / 4718 bytes at the three breakpoints and records `nonBlank: true` on all three — **a page with zero glyphs clears the floor by 4.6x**, and the smallest capture in the entire 19-artefact pool was 2541 B. The gate detects a **truncated capture**, not a blank page; it can observe a broken capture pipeline and cannot observe an empty one. **This one was found by an agent correcting the orchestrator.** Four agents were briefed that this gate "already fails a blank page" and told to prove any new check was not a subset of it; one measured the premise instead of accepting it and reported it false. The brief was the defect. A BLOCKING gate whose name overstates it is worse than a missing gate, because every later design reasons from the name. |
| 13 | **The drafted `decideMotion` assertions** — `dashboard/server/src/design/motion-staging.test.ts` | **Added to this table 2026-07-30; the instance is recorded in that file's own docblock (`:14-48`) and was closed there.** The regression was mutated INTO the compiled `decideMotion` — "a `capability = { video: false }` default parameter gating the scroll-scrubbed-video branch" — and the drafted suite came back `pass 3 · fail 0`. Two independent reasons, quoted from `:26-34`: **(1)** *"`Function.length` counts parameters BEFORE the first defaulted one, so `(files, capability = …)` still reports 1. Only a REQUIRED second parameter moves it."* **(2)** *"The drafted fixture drove `.currentTime` from inside `requestAnimationFrame`, so branch 3 — 'rAF-driven element scrubbing' — satisfied it anyway and `kind: "satisfied"` never changed."* Closed in the same file two ways: an extra call (`:81-86`) passing a capability-shaped second argument through a cast and demanding the same verdict, and a rAF-FREE fixture asserted on the **satisfier string** rather than on `kind`, so removing the video term is visible rather than absorbed by a sibling term. **And the row's sharper half:** mutating the CALL SITE in the compiled hook instead — `decideMotion(files.filter((f) => !/\.currentTime/.test(f.text)))`, leaving `decideMotion` untouched — **left all four of those assertions green** and was caught only by the hook test at the bottom of the file (`antislop-hook.ts:393` is the production caller). Same sub-shape as 2/3/6/7, demonstrated in the same file: a direct call can never observe what the caller does. |
| 14 | **The truncated-download fixture** — `docs/superpowers/plans/2026-07-29-phase-2c-image-to-video.md:836-872` | **Added 2026-07-30, and it is the only row in this table caught at PLAN stage rather than in a shipped check** — labelled so, because a plan-stage catch is cheap and a shipped one is not. The download guard has three parts; the truncation fixture reaches **one**. `curl` exits 18 on a short transfer and the script's `|| METRICS="000 0 0"` fallback then discards the numbers, and the fake server's own behaviour (declares 5,000,000 bytes, writes 1,000, destroys the socket) makes `%{size_download}` and `wc -c` AGREE at 1,000 — so the byte-match check passes and only the 4096-byte floor can go red. The plan states this itself ("if removing both guards does not turn the test red, the fixture is wrong, not the guard") and records two executed mutations. **UNVERIFIED here:** no `METRICS=` string exists anywhere under `dashboard/server/`, so which form actually shipped could not be checked without a shell — the downloader is a script outside this repository. |

| 15 | **`countDesignPngs`** — `dashboard/server/src/design-manifest.ts` | It counted **filenames**, not images: `endsWith(".png")`. So five zero-byte files named `.png` counted as five stills, and the run's five real stills — which the generator writes as **JPEG bytes into a `.png` name** — would have counted as zero under any honest reading of the name. **Closed 2026-07-30** by `isDesignImageFile(path)`, which reads the first 8 bytes for a PNG or JPEG signature and has **no extension filter at all**; a zero-byte file has no signature, and a directory named `old.png` throws EISDIR, is caught, and the fd closed in `finally`. **Red in BOTH directions:** reverting to `endsWith(".png")` gives `five zero-byte files named .png are not five images — actual: 5, expected: 0` (7 tests) and `the run's five real stills are JPEG; they must still count as five — actual: 0, expected: 5` (4 tests). The zero-byte test also asserts the **branch**, not just the integer: the outcome moves from `failure: null` to `failure: "no-images"`. **A fixture agreed with the defect and had to be fixed with it** — `orchestrator.test.ts:387` wrote the literal text `not really a png N`, so the suite was calibrated on files that were never images. Two residues, reported not fixed: the export is still *named* `countDesignPngs` while counting JPEGs, and the wrong extension originates upstream in the design agent's `-o …/NN-section.png` argument. |
| 16 | **`GATE:boot`'s static arm** — `bakeoff/src/tier0.ts`, and it is instance 12 in a second gate | Its threshold is `text.trim().length > 0`, so **a one-byte body `<` passes, `<!-- nothing -->` passes, and the 199-byte / zero-glyph `blank-page` fixture passes.** `bakeoff/STATUS.md` has said since 2026-07-27 that "a blank page is not a pass"; only an empty or whitespace-only **response** is not. The mutation `> 0` → `true` reddens exactly the two new tests that check the threshold, so the arm is now pinned — **and the survival is recorded as DATA rather than quietly fixed.** The threshold was deliberately NOT tightened, for a mechanism reason, and three strings in `scorer-container.ts` still overstate what it can see: **the measurement, the eight-fixture false-positive table and the reasoning all live once, in §1.5** — this row catalogues the shape, that section holds the numbers. |
| 17 | **The `heldConstants` block in `run.json`** — `dashboard/server/src/orchestrator.ts:1967`, found by the verification pass over the fix wave itself | A lane replaced the record's literal `egress: "denied"` with a derived value that **cannot** return `"denied"` (a denial is a measurement, not a configuration), pinned the derivation with a test, and reported it fixed. The verification agent mutated the **write site** straight back to `networkPolicy: {egress: "denied", allowedHosts: []}` and the suite stayed **GREEN at 850/848/0/2**. Nothing reads `run.json`: `heldConstants` appears in `dashboard/server/src` only at the construction, the field, and three comments. The site is not dead — a side-effect marker there fires **23 times** per suite run and writes the honest value to disk each time — so the record IS produced under test and no assertion looks at it. **The gap covers the whole block** (`harness`, `imageRef`, `imageDigest`, `acceptanceSuiteSha256`, `tokenAccountingRule`), not just `networkPolicy`. Beside it, a **dominated** assertion: `orchestrator.test.ts:1795`'s `deepEqual(DASHBOARD_SANDBOX.networkPolicy, recordedNetworkPolicy(sandbox?.network))` cannot be reddened by any mutation the line above it does not catch first, because the left side *is* `recordedNetworkPolicy(undefined)`. **Left unfixed by the pass that found it, on purpose** — patching another lane's committed test inside the pass that found the survivor is the quiet fix this table exists to prevent. **CLOSED 2026-07-30 by the orchestrator, in commit `a734b71`, test file only** (`orchestrator.ts` byte-unchanged): two assertions read the WRITTEN `run.json` off disk rather than calling a helper, because extracting the assembly into a testable function would move the hole one line — instance 6. The first `deepEqual`s the recorded policy against `recordedNetworkPolicy(undefined)`; the second separately rejects the literal word `denied`, since the first would also pass if that function itself started returning a denial. A third asserts every `heldConstants` field is present and that the recorded suite digest is the one the run actually froze. **The surviving mutation now fails ALONE (42/43).** |

**TWO more of this shape were found and killed INSIDE the 2026-07-30 wave rather
than shipped, and they are recorded without a number because nothing shipped over
them** — the numbered rows are the ones that reached a green suite somebody trusted.
(A third in-wave find, the vacuous headline inequality, is preamble item 4 above
rather than a bullet here, because its lesson generalises past the one test it was
found in. **Counted once, in one place** — this table's whole subject is counters
that lag, and it would be self-parody to double-count inside it.)

- **Two dominated assertions in a lane's own new test**, deleted with the reason
  written in-file rather than kept: `droppedByCap === 0` (two refs against a cap of
  two — it cannot drop) and `VEO_ASPECTS.includes(plan.legs[0].aspect)` (guaranteed
  by construction at `video-legs.ts:127`). They were found because two controls
  died on a `marked.length` assertion *before* reaching the plan, which proved the
  lines below it were unreachable by any mutation.
- **A survivor kept deliberately and documented instead of fixed:**
  `spendByVendor`'s `contribution.provider` can be hardcoded and nothing goes red.
  It is unobservable **by construction** — the emitted row's provider comes from the
  map key, and a test that could kill it would need an `ApiSeatSpend` whose provider
  disagrees with itself, which the type forbids. Recorded at the declaration site as
  what it is: a line that keeps a refusal reachable, not a checked invariant.

**Seventeen is a running tally, not a final count. If you find an eighteenth,
increment it here and say what it could not see.** Four counters lag it by
construction and are left rather than swept, so the drift stays visible:
`claude-builder.test.ts:1753` says "six times" (written before instance 7);
`calibration.test.ts:19` says "five times" of the narrower
*skipped-and-reported-green* sub-shape, which is its own count and not this one;
`docs/superpowers/plans/2026-07-29-phase-4-cron.md:124` says "the twelve recorded
instances"; and §5 item 10 said "seven" until 2026-07-30, when it had been twelve
for a day. **A lagging counter in a plan is cheap; a lagging one in this table is
the defect itself.**

**2026-07-30 (§7 is new — the plain answer the owner asked for twice.)** §5 item 10
now reads seventeen, and the `bakeoff/STATUS.md`
cross-reference was moved with it. The two counters in files outside these two —
`claude-builder.test.ts:1753` and the cron plan's `:124` — **were not touched and
still lag**; they are reported here rather than edited, because a status pass
reaching into a test file to change a number is how a measurement gets
"corrected" by somebody who did not measure it. `calibration.test.ts:19` is
deliberately left alone: it counts a narrower sub-shape and says so.

---

## 7. Would I leave this running unattended tonight? — 2026-07-30

**Yes, for one ticket, on the Anthropic path, with the laptop's own quota and
nobody else's — and I would look at it in the morning rather than trust what it
tells me about itself.** §1.0 is the reason the answer is yes at all: the whole
path ran for 1 h 44 m, nothing was skipped, the sealed gate scored a real build,
and the held-out half found a genuine defect the builder had not noticed. That is a
system that works, and it is one run old.

**What I would still not trust it with, in the order the risk actually bites:**

1. **Spend visibility — the one that bites tonight.** No dollar figure exists by
   construction (§1.8) and **no token figure is recorded either**: the spend tables,
   the per-vendor arithmetic and the pricing footer all landed without their five
   writers (§1.10). A 1 h 44 m run leaves no spend row, so the only account of what
   an overnight run cost is a 429 and the provider's own dashboard. It fails
   honestly rather than printing a zero — but if quota matters, this is the gap that
   matters, and it is a wiring job, not a design question.
2. **The held-out boundary is inherited, not re-derived.** §1.0 attempted no sealed
   read, so no layer fired in it. Every reason to trust a `heldOutPass` from
   tonight's run still comes from §0.1's removal proofs on 2026-07-29 — real
   proofs, on a different day, in a tree that has moved several hundred tests since.
   And they are proofs about **Anthropic only**: on the Codex path nothing stops a
   build reading the sealed suite (§0.1, last row), so do not leave a Codex run
   unattended and then quote its `heldOutPass`.
3. **The visible half cannot execute here.** The OS sandbox refuses `listen` on
   127.0.0.1, so a builder cannot serve its own artefact and cannot run the suite it
   was handed (§1.0). Overnight, that means the build gets no feedback it can act on
   between its own reasoning and the sealed gate — weaker than the bake-off path,
   and the reason a fix round is worth more here than it looks.
4. **What the verification pass left open — two of four are now CLOSED.**
   ~~The `heldConstants` block in `run.json` is asserted by nothing~~ — **closed
   2026-07-30, `a734b71`**, §6 instance 17; the surviving mutation now fails alone.
   ~~`results/scores/<runId>.json` carries held-out test titles verbatim outside all
   three deny layers~~ — **closed 2026-07-30, `32b64e5`**, and it was the most
   serious defect of the session: 24 verbatim titles in the live run's score record,
   `results/scores` in no deny layer, and the suite frozen per ticket and reused
   across attempts, so a builder reading a prior run's score would have learned the
   titles it was about to be graded against while `heldOutPass` stayed true. The
   reason no test could have caught it is recorded with the fix: `SegmentCall` did
   not capture `sealedRoots`, so the deny set was not observable from a test at all.
   **STILL OPEN:** `orchestrator.ts:1663-1665` assigns instead of merging, so a
   run's reported tokens **go down** at the first fix round — read-verified, never
   executed. And `http.ts:586` serves JPEG bytes as `image/png`.
5. **The scorer image HAS now been re-resolved — 2026-07-30, with a shell.**
   `docker image inspect bakeoff-scorer:1 --format '{{.Id}}'` returns
   **`sha256:fae56a4e1374ee215bb1d23c20b2c55519f8c071bdb6c283d77ef29288e33770`**,
   the fifth value in §1.2's chain. It was also checked for staleness rather than
   assumed current: the image was created 04:39:27 and `bakeoff/src/tier0.ts` last
   modified 04:37:05, so the build includes the `GATE:boot` fix. **What is still
   outstanding is the dry run against THIS image** — the green one on record belongs
   to `c98bad3a…`. That is §5 item 4, it is ten minutes, and it is the difference
   between "the run is comparable" and "the run is a story".

   **SUPERSEDED 2026-08-02 — the tag has moved and this item's two open ends are
   both closed.** `bakeoff-scorer:1` now resolves to
   **`sha256:b7a9fd0a0f58e4a2f4eef5bebe754d839cb2e6013b386f804841bbe0bf4da8a8`**
   (move #5, the sixth value in §1.2's chain; `spec-agent.ts` was rewritten and
   stage 1 compiles all of `src/`). `fae56a4e…` is preserved as
   **`bakeoff-scorer:pre-specmode`** — the paragraph above stays because it is a
   correct record of 2026-07-30, and its digest is still resolvable, just under a
   different tag. **The dry run against the current image was then run and is
   green:** `npm run bakeoff -- dry-run`, exit 0, **24 checks, 0 failures**, twice,
   for $0 on the stub builder, with STAGE 4 printing `sha256:b7a9fd0a…` as the
   image the sealed gate resolved by content digest. So "the run is comparable"
   now holds for anything scored from here — and **only** from here: everything
   stamped `fae56a4e…` sits on the far side of the move (§1.2, "what move #5
   costs").

**The honest one-line version:** it will finish a ticket unattended and its verdict
is worth reading; it will not tell you what it spent, it cannot prove tonight that
the tests it graded itself against were sealed, and its most important
held-constant is currently somebody's word. **Corrected 2026-08-02 on the last
clause only:** the held-constant is no longer somebody's word — the digest was
resolved, the rebuilt image was opened and read, and the dry run was executed
against it. The first two clauses stand unchanged.
