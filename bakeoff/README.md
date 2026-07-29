# bakeoff

A measurement harness. Its only job is to replace the modelled cost and quality
numbers in `docs/research/03-model-decision-final.md` with **measured** ones,
taken from the owner's own tickets, before the autonomous coding agent is built.

No published board contains Claude Opus 5, Claude Sonnet 5, Kimi K3, DeepSeek V4
and GPT-5.6 Luna together on a long-horizon greenfield coding task. The
comparison this project needs does not exist in public and cannot be bought.

**This directory is the scaffold: the frozen contracts, the configuration
matrix, credential preflight, canonical hashing and the redaction chokepoint.**
It runs no builds and spends no money. The build runner, the spec agent, the
suite auditor and the sealed scorer are separate programs that implement the
interfaces in `src/contracts.ts`.

---

## The protocol

This implements **doc 03 section 7, "THE BAKE-OFF PROTOCOL"**, with the
configuration matrix updated for the measured leaderboard in **doc 05**
(`05-vals-terminal-bench-2-1-measured.md`), the caching and instrumentation
specification in **doc 04** sections 3 and 9, and the gate design in **doc 02**
section 5.

Five things are non-negotiable. They come from measured findings, not
preference.

### 1. A sealed, held-out acceptance gate

The acceptance suite is authored by a **separate agent from the ticket text
alone, before any build run, with no access to any implementation**. It is
hashed and frozen (`acceptanceSuiteDigest` in `src/hash.ts`). No builder may
read, list or modify it. It executes in a clean container with **no network and
no access to the build workspace history**. Before any build starts, a separate
adversarial pass audits it for tests that are vacuous, tautological,
mis-specified or trivially satisfiable; a suite that fails the audit is
regenerated, not used (`assertSuiteUsable`).

**The builder's self-report is RECORDED and NEVER scores anything.**
`RunRecord.agentDeclaredDone` exists for exactly one purpose: computing
`falseFinish`.

Why: Cursor measured **14.1–20.7pp** of apparent quality evaporating when the
environment was sealed. ImpossibleBench measured Claude-family models editing
test files **more than 79% of the time** when they could. Filesystem
permissions plus a diff gate — a prompt instruction is not sufficient.

### 2. Co-primary metrics — both required, neither alone

| Metric | Definition |
|---|---|
| `held_out_pass` | the frozen suite goes green in the clean container |
| `false_finish` | the agent **declared done** AND the held-out suite **failed** |

`false_finish` is the metric that matters. In the product it is the failure that
ships a broken app to a paying customer. LHTB measures this mode at 19% of
unresolved runs.

Secondary: timeout rate, wall clock, `BLOCKED` rate, measured cache-hit token
fraction **per vendor**, and $ per attempt. Derived, explicitly not primary:
$ per held-out pass.

Both definitions live in exactly one place — `computeHeldOutPass` and
`deriveFalseFinish` in `src/contracts.ts`. Do not reimplement them.

### 3. A hard cost ceiling and kill switch, enforced out-of-process

Checked **before each API call**, in dollars, against the worst-case cost of the
call about to be dispatched (`PreCallDecision`). Vendor task-budget parameters
are **advisory** — Anthropic's own docs say Claude may exceed the budget mid-
action, Sonnet 5 has no task_budget at all, and Moonshot and DeepSeek have no
budget primitive of any kind. They are recorded (`VendorAdvisoryBudget`) and
never trusted.

Termination happens on a **budget boundary only**. `KillReason` is a closed
union with no "stuck", "looping" or "no progress" member, and none may be added:
**79% of unresolved long-horizon runs time out while still actively making
progress**. A heuristic stuck-detector kills runs that were converging.

A model with no verified price is **not runnable**, and preflight says so with
the exact remediation. A ceiling denominated in dollars cannot be enforced
without a per-million-token price; running unpriced means running uncapped.

### 4. Token accounting is per vendor and never compared across vendors

Tokenizers differ. Anthropic's own docs state its 4.7+ tokenizer produces
approximately 30% more tokens for the same text than earlier Claude models, and
nobody has measured tokens-per-identical-source-text across vendors.

Raw `input` / `cache_read` / `cache_write` / `output` counts are recorded per
vendor, separately (`VendorUsage`). **Compare dollars and outcomes only.** The
module ships `sumCostUsd` and deliberately ships no token-summing helper.

### 5. Six variables held constant

| # | Variable | Rule |
|---|---|---|
| 1 | **Reasoning effort** | Fixed per (model, role) and **recorded** on every run. Effort alone is worth 250–497 Elo, far more than the model gap being measured. Rung names are **not** comparable across vendors — Anthropic has five rungs, Moonshot three, DeepSeek two. |
| 2 | **Harness** | One harness, ours, for every configuration. |
| 3 | **Sandbox image + network policy** | Identical image **digest** (never a mutable tag) and identical sealed egress policy. |
| 4 | **Repeat count** | Same for every configuration in a phase: 1 to screen, 3 for the finalists. |
| 5 | **The held-out suite** | One per ticket, frozen; every configuration builds against the same one. |
| 6 | **Token accounting** | Per vendor, never summed across vendors. |

Five of these come from the measurement-integrity finding that Artificial
Analysis and Vals AI both run Terminal-Bench 2.1 on a Terminus 2 harness and
differ by ~4pp — larger than the gap this bake-off is trying to detect.

`heldConstantsFor()` in `src/config.ts` snapshots all six into every run record,
so a result can be audited without this source tree.

---

## The configuration matrix

| id | label | orchestrator | subagent |
|---|---|---|---|
| **A** | baseline | Claude Opus 5 `high` | Claude Sonnet 5 `medium` |
| **B** | deepseek-sub | Claude Opus 5 `high` | DeepSeek V4 Pro `max` |
| **C** | kimi-orch | Kimi K3 `high` | Claude Sonnet 5 `medium` |
| **D** | kimi-sub | Claude Opus 5 `high` | Kimi K3 `high` |
| **E** | luna-sub | Claude Opus 5 `high` | GPT-5.6 Luna `medium` |

D and E exist because the measured Vals AI board shows both models beating
Claude Sonnet 5 on **both** score and cost/test in the identical harness:
Kimi K3 +6.37pp at 2.4x lower cost/test, GPT-5.6 Luna +4.50pp at 3.0x lower.

**Every configuration uses the same spec seat (Claude Opus 5 at `xhigh`) and the
same judge seat.** The acceptance gate is a held-constant control, not a
variable under test. Consequently: **a good result for a configuration does not
mean that model could author its own acceptance suites.** A real all-DeepSeek
product would have a model with a measured 94% hallucination rate writing its
own acceptance criteria, which is a materially worse proposition than anything
measured here.

The deviation from doc 03 section 7.2's four-configuration table (this matrix
drops all-DeepSeek and adds two subagent swaps) is argued at the top of
`src/config.ts`.

---

## Running it

> **Read `STATUS.md` first.** It records what is tested, what has never touched
> a vendor, and two open blockers. It is the honest counterpart to this file.

```bash
npm install
npm run typecheck          # tsc --noEmit, strict
npm run build              # emits dist/ with declarations and source maps
npm test                   # unit tests
```

Exit codes, everywhere: `0` success, `1` blocked (a control did not hold, a
configuration cannot run, a run could not be scored), `2` usage error or a
violated invariant.

With no credentials set, every subcommand fails **clean**: a named error code,
the problem, and the exact action that clears it. Never a stack trace, and never
a silently skipped configuration — a silently skipped configuration turns a
five-arm experiment into a four-arm one without saying so.

### The subcommands, and what each costs

| Command | Spends | What it does |
|---|---|---|
| `dry-run` | **$0** | The whole pipeline against a stub provider. **Do this first.** |
| `preflight` | $0 | Which configs can run, and what blocks the rest. Default command. |
| `configs` | $0 | The matrix, seat by seat, with its evidence. |
| `pricing` | $0 | The price table and the status of every field. |
| `protocol` | $0 | Held constants, metrics, phases, budgets, forbidden paths. |
| `freeze` | $0 | Seals the ticket set; verifies every sealed acceptance suite. |
| `screen` | **~$1,970** | Every runnable config x every ticket x 1. Needs `--yes`. |
| `finals` | **~$900** | Finalists x hard tickets x 3. Needs `--yes`. |
| `score` | $0 vendor spend (CPU only) | Runs the sealed gate over the run records. |
| `report` | $0 | Joins the records, applies the decision rule, writes `REPORT.md`. |

`screen` and `finals` print a modelled estimate and **refuse to start without
`--yes`**. They also run `preflight` themselves and refuse if any *selected*
configuration is blocked.

### Environment variables

Credentials — **names only, values read at run time, never written to disk**.
Copy `.env.example` to `.env` and fill it in your editor. Never paste a key into
a chat transcript.

| Variable | Needed by |
|---|---|
| `ANTHROPIC_API_KEY` | configs **A, B, C, D, E** — orchestrator, spec and judge seats, and A/C's subagent |
| `MOONSHOT_API_KEY` | config **C** (orchestrator), config **D** (subagent) |
| `DEEPSEEK_API_KEY` | config **B** (subagent) |
| `OPENAI_API_KEY` | config **E** (subagent) — also blocked on price, see `STATUS.md` |

The spec and judge seats are Anthropic in **every** configuration, so
`ANTHROPIC_API_KEY` is required even to run config C or D alone.

Non-secret configuration for the sealed gate:

| Variable | Default | Meaning |
|---|---|---|
| `BAKEOFF_SCORER_IMAGE` | `bakeoff-scorer:1` | Scorer image. **Pin by digest.** |
| `BAKEOFF_RESULTS_DIR` | `results` | Score records, tamper reports, screenshots |
| `BAKEOFF_ACCEPTANCE_ROOT` | `acceptance/generated` | Sealed suite store |
| `BAKEOFF_SCORER_TIMEOUT_MIN` | image default | Hard boundary on one scoring container |

Setting `ANTHROPIC_BASE_URL` / `MOONSHOT_BASE_URL` / `DEEPSEEK_BASE_URL` /
`OPENAI_BASE_URL` routes traffic through a gateway. `preflight` **warns**: two
documented community cost blowups were gateway bugs that silently broke prompt
caching, and a broken cache is a 0%-hit-rate run at up to 2.4x the modelled
bill, invisible everywhere except the cache usage fields.

---

## RUNBOOK — zero to a report

Every step is `$0` until step 7, which is labelled.

```bash
# 0. Build.
cd bakeoff && npm install && npm run build && npm test

# 1. VALIDATE THE HARNESS FOR $0. Do not skip this.
docker build --provenance=false --sbom=false \
  -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .
docker pull node:22                      # the builder sandbox stand-in
npm run bakeoff -- dry-run               # must exit 0 before you spend anything
```

`dry-run` exercises the real freeze, the real bad-test audit, the real
pre-call ceiling, the real sealed build container, the real `--network=none`
gate and the real decision rule. Only three things are stubbed: the model
responses, the builder binary, and the spec seat's authoring call. Options:
`--root <dir>` (default `./dry-run`, a **sibling** of `./results` so a plain
`report` can never pick it up), `--builder-image`, `--scorer-image`,
`--no-docker` (stages 1, 2 and 5 only — **leaves the seal unproved**).

```bash
# 2. Your tickets. Replace the six reference briefs with your own, then:
rm tickets/FROZEN.json
npm run bakeoff -- freeze                # seals the set; prints every digest

# 3. Confirm every price on the vendor's own pricing page, then:
npm run bakeoff -- pricing

# 4. Author the sealed acceptance suites — ONCE per ticket, from the ticket
#    text alone, by the spec seat, BEFORE any build run. A separate agent
#    audits each suite adversarially. See src/spec-agent.ts.
#    (Costs a few dollars per ticket in spec-seat tokens.)

# 5. Prove every ticket has a sealed, audited suite. Refuses to proceed if not.
npm run bakeoff -- freeze

# 6. Check what can run and what is blocked.
npm run bakeoff -- preflight             # exits 1 while anything is blocked

# 7. >>> THIS SPENDS MONEY <<<
npm run bakeoff -- screen --yes \
  --sandbox-image <ref> --sandbox-digest sha256:... \
  --configs A,B,C,D                      # naming a reduced matrix is deliberate

# 8. Score. The gate is a separate module, loaded explicitly.
npm run bakeoff -- score --gate ./dist/gate.js

# 9. Report.
npm run bakeoff -- report                # writes results/REPORT.md
```

Then, for the finalists only:

```bash
npm run bakeoff -- finals --yes --configs A,<challenger> \
  --sandbox-image <ref> --sandbox-digest sha256:...
npm run bakeoff -- score --gate ./dist/gate.js
npm run bakeoff -- report
```

**The order is the design.** A suite must be authored and audited before any
build run; a changed brief invalidates its suite (`acceptanceSuiteDigest` covers
`ticketSha256`), so re-freezing forces regeneration and re-audit. The sequence
runs forwards only: `freeze -> author -> audit -> run -> score -> report`.

### Before the first run

1. **Confirm every price in a browser.** doc 03 states plainly that its figures
   came through a summarising fetch tool rather than rendered HTML, and that any
   number justifying spend above ~$1,000 must be re-confirmed. This costs ~$2,100.
2. **Retrieve the GPT-5.6 Luna list price and API model ID.** Config E is blocked
   until then. doc 05's `$0.27` is Cost/Test on an 89-task suite and doc 05
   caveat 1 explicitly forbids substituting it into a per-ticket model.
3. **Request an API spend-limit increase.** Anthropic's Start tier is a $500/month
   cap after which usage pauses until the next month. At $85–124/ticket one
   runaway loop exhausts a month.
4. **Pin the sandbox by digest, not by tag.** `heldConstantsFor()` refuses a tag.
5. **Freeze the six reference ticket briefs** and record their digests
   (`ticketDigest`). Never edit them between runs.
6. **Write the decision rule down before seeing any result.** It is already
   encoded: `applyDecisionRule` in `src/contracts.ts`.

---

## What it costs

Recomputed for **this** matrix. doc 03 section 7.7's ~$2,100 headline is for its
**four**-config table, whose fourth arm was all-DeepSeek at $109 for six
tickets; this matrix has five configs and replaces that cheap arm with
kimi-sub, the most expensive one. Per-ticket figures from doc 03 section 4.3,
six tickets each:

| Screen arm | $/ticket (modelled) | 6 tickets |
|---|---:|---:|
| A baseline | $64.97 | ~$390 |
| B deepseek-sub | $29.78 sticker / $39.91 token-adjusted | ~$240 |
| C kimi-orch | $54.12 cached / $74.77 uncached | ~$450 |
| D kimi-sub | $81.84 | ~$491 |
| E luna-sub | **unknown until its price is retrieved** | ~$400 placeholder |
| **Screen** | | **~$1,970** |
| Finals: 2 configs × 2 hard tickets × 3 repeats (12 runs) | | ~$900 |
| Failed runs, spec regeneration, contingency | | ~$300 |
| **Planned total** | | **~$3,170** |

Default ceilings (`DEFAULT_BUDGET`): **$120 per run**, **4 hours per run**,
**$3,500 per campaign**, warning at 80% of the run ceiling. The campaign ceiling
sits ~10% above planned spend on purpose: **a campaign ceiling set below planned
spend is a planning error that presents as a budget event** — the run terminates
mid-experiment, on a boundary, and a partial matrix looks like a result.
Recompute it if config E's real price lands above the placeholder. Confirm all
of it against your own account limits.

Do **not** economise by dropping the repeat count on the finalists: a single run
is exactly the noise problem that makes every open-weight cost figure in doc 03
section 4 unreliable.

## The decision rule — committed to in advance

Switch away from config A **only if all three hold**:

1. the alternative's held-out pass rate is within **one standard error** of
   baseline;
2. its **$ per held-out pass is at least 30% lower**;
3. its **false-finish rate is not higher** than baseline.

Otherwise the question is closed for 90 days. Encoded as `applyDecisionRule`.

---

## SECURITY

- **No credential value is ever written to a file, an example, a fixture or a
  commit.** Every credential is read from a named environment variable at run
  time only. `.env.example` carries variable **names** with empty values;
  `.env` is gitignored.
- **`src/env.ts` never returns, prints, persists, hashes or length-reports a
  value.** It returns a boolean and a problem code. No prefix, no last-4, no
  fingerprint — a partial is still a leak.
- **The harness forwards credentials into the sandbox by variable name.**
  Nothing in this codebase needs to materialise a secret in TypeScript.
- **`src/redact.ts` is the single chokepoint.** Everything written to results,
  logs or reports passes through `redactForPersistence`, including anything a
  judge or auditor will later read — a grader reading an un-redacted trace is
  itself a context leak. It handles raw, base64 (standard, url-safe, unpadded),
  percent-encoded, JSON-escaped and `\u`-escaped forms of known values, plus an
  independent pattern/entropy pass for secrets that were never registered, plus
  a decode-and-retest pass over base64 and percent-encoded spans.
- **Redaction runs on reassembled text, never per chunk.** A regex applied per
  SSE delta cannot match a key split across two chunks.
  `ReassemblingRedactor` buffers, never cuts through a candidate match, and
  holds back a 16 KiB tail. There is deliberately no per-chunk function.
- **Never paste a key into a chat transcript.** Transcripts are persisted; a
  pasted key is exposed and must be rotated.

---

## Exported symbols

Other agents build against these. Names are frozen.

**`src/contracts.ts`** — types: `Provider`, `SeatRole`, `AnthropicEffort`,
`MoonshotEffort`, `DeepSeekEffort`, `OpenAIEffort`, `Effort`, `EffortSource`,
`AnthropicSeat`, `MoonshotSeat`, `DeepSeekSeat`, `OpenAISeat`, `ModelSeat`,
`EffortValidation`, `TicketTier`, `Ticket`, `CriterionTier`,
`AcceptanceCriterion`, `TestFileRef`, `AuditFindingKind`, `AuditFinding`,
`HarnessIdentity`, `AcceptanceSuite`, `BakeoffConfig`, `PriceField`,
`PriceStatus`, `ModelPrice`, `ResolvedPrice`, `PricingBasis`, `VendorUsage`,
`UsageCounts`, `PriceUsageOptions`, `NetworkPolicy`, `SandboxSpec`,
`RecordedEffort`, `HeldConstants`, `KillReason`, `VendorAdvisoryBudget`,
`BudgetPolicy`, `PreCallDecision`, `LedgerEvent`, `RunStatus`, `RunRecord`,
`CriterionResult`, `ScoreRecord`, `SuiteExecution`, `ConfigOutcome`,
`DecisionRuleInput`, `DecisionRuleResult`, `BakeoffErrorCode`, `ProviderAdapter`,
`AcceptanceSuiteAuthor`, `AcceptanceSuiteAuditor`, `RunRequest`,
`BakeoffRunner`, `AcceptanceGate`.
Values: `BAKEOFF_SCHEMA_VERSION`, `BakeoffError`, `notImplemented`, `PROVIDERS`,
`EFFORT_LADDERS`, `validateSeatEffort`, `assertSuiteUsable`, `seatFor`,
`PRICE_FIELDS`, `PRICE_TABLE`, `resolvePrice`, `pricingBasisOf`,
`vendorCacheHitFraction`, `priceVendorUsage`, `assertNoDuplicateUsageRows`,
`sumCostUsd`, `TOKEN_ACCOUNTING_RULE`, `computeHeldOutPass`,
`deriveFalseFinish`, `dollarsPerHeldOutPass`, `applyDecisionRule`.

**`src/config.ts`** — `OPUS_5_ORCHESTRATOR`, `SONNET_5_SUBAGENT`,
`KIMI_K3_ORCHESTRATOR`, `KIMI_K3_SUBAGENT`, `DEEPSEEK_V4_PRO_SUBAGENT`,
`GPT_5_6_LUNA_SUBAGENT`, `SPEC_SEAT`, `JUDGE_SEAT`, `CONFIGS`, `CONFIG_IDS`,
`BASELINE_CONFIG_ID`, `getConfig`, `HELD_CONSTANT_VARIABLES`,
`BUILDER_FORBIDDEN_PATH_PREFIXES`, `recordedEffortsFor`, `HeldConstantsInput`,
`heldConstantsFor`, `SEALED_NETWORK_POLICY`, `Phase`, `PHASES`, `TicketSlot`,
`REFERENCE_TICKET_SLOTS`, `DEFAULT_BUDGET`, `MatrixProblem`,
`validateConfigMatrix`.

**`src/env.ts`** — `CredentialProblem`, `CredentialCheck`, `checkCredential`,
`requiredEnvNamesFor`, `baseUrlEnvNameFor`, `BlockerKind`, `Blocker`,
`WarningKind`, `PreflightWarning`, `SeatPricingReadiness`, `SeatReadiness`,
`ConfigStatus`, `ConfigReadiness`, `PreflightReport`, `PreflightOptions`,
`preflight`, `assertConfigRunnable`, `formatPreflightReport`.

**`src/redact.ts`** — `REDACTION_PLACEHOLDER_PREFIX`, `OVERLAP_WINDOW_CHARS`,
`MAX_BUFFER_CHARS`, `RedactionRule`, `CREDENTIAL_RULES`, `RedactionFinding`,
`RedactionResult`, `RedactOptions`, `DEFAULT_KNOWN_ENV_NAMES`,
`knownValueEncodings`, `redactKnownEnvValues`, `redactText`, `isDigestSafeKey`,
`redactDeep`, `redactForPersistence`, `assertRedacted`, `ReassemblingRedactor`.

**`src/hash.ts`** — `sha256Hex`, `JsonPrimitive`, `JsonValue`, `canonicalJson`,
`canonicalJsonDigest`, `ticketDigest`, `ticketDigestMatches`, `fileDigest`,
`digestFileSet`, `AcceptanceSuiteDigestInput`, `acceptanceSuiteDigest`,
`assertSuiteDigestMatches`.

## What is deliberately not here

- **The build runner.** Implements `BakeoffRunner`. Must enforce `BudgetPolicy`
  out of process and must give the builder no path to the acceptance suite.
- **The spec agent and the bad-test auditor.** Implement `AcceptanceSuiteAuthor`
  and `AcceptanceSuiteAuditor`, as structurally separate agents with no shared
  conversation history: Anthropic measured a model tasked with writing its own
  reward-hack classifier attempting sabotage 12% of the time.
- **The sealed scorer.** Implements `AcceptanceGate`.
- **Provider adapters.** Implement `ProviderAdapter`. `normalizeUsage` must throw
  on an unrecognised payload; a field the vendor did not report is never
  recorded as `0`.
- **The six ticket briefs.** Owner-authored real work, frozen verbatim, hashed.
  Inventing them here would make the bake-off measure fabricated work instead of
  the owner's own tickets, which is the entire reason the protocol exists.
