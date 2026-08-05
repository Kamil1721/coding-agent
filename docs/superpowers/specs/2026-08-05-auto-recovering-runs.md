# Auto-recovering runs — design spec

Date: 2026-08-05
Status: DECIDED, ready to build. Every open question is named in §12; nothing else is left to the implementer.
Scope: `dashboard/server/**`, `bakeoff/src/anthropic-seat.ts`, `bakeoff/src/subscription`-adjacent caller, `dashboard/src/lib/api-types.ts` (the mirror only).

The owner's constraint, which decides every trade-off below:

> "context loss is not ok, using up a lot of tokens is." / "the agent should be self maintaining" /
> "ideally if it does not have to resume but it just done it is ideal."

Read as: a run CONTINUES ITSELF through a recoverable failure, and the owner learns about the failure
only from an honest record afterwards. Spending a second spec phase, or waiting five days for a
provider window, is cheap next to throwing away 52 minutes or 12 hours of work.

---

## 0. What this spec decides, in one page

| Question | Decision |
|---|---|
| Where recovery lives | Inside the single `Orchestrator`, at the **per-phase seams** (`orchestrator.ts:1801-1820`, `:1848-1852`, `:1873-1877`) and in `reconcileOnBoot` (`:1567-1579`). Never after `#finish`. Never a second process. |
| Failure classes | `intentional`, `throttled`, `interrupted`, `transient`, `structural`, `graded`. Six, closed set, first-match-wins in that order. |
| Which class actually recovers in v1 | `throttled` (all phases, including spec — today it kills the run) and `interrupted` (server restart). `transient` ships with a tested policy and **no reachable signal**, deliberately (§3.4). |
| Bound | ONE counter, `auto_continue_count`, cap 3, shared across classes. Plus a wait ceiling of 6 h (env-overridable) that the existing 32-bit guard does not catch. |
| Boundary with the call-level ladder | The call level owns "the same request with a different parameter" (the overflow ladder). Anything that escapes it arrives as `BakeoffError`, which the phase classifier maps to **`structural`, bound 0**. The phase level never retries a `max_tokens` failure. |
| Suite re-authoring | Structurally impossible: `assertSuiteIntact` reuse comes first (`orchestrator.ts:2436-2451`) and `freezeSuite` is called with `overwrite: false` (`:2540`), so a second yardstick cannot be produced. A spec-phase continuation authors a suite that does not yet exist, which is not the same thing (§5.2). |
| New run status | **NO.** v1 needs none. `throttled` reuses `rate_limited`; `interrupted` goes straight to `queued`. The `recovering` status is specified in §8.4 as the price of the deferred `transient` arm, with all four hand-written status lists enumerated. |
| The record | New table `run_attempts` (needs no ALTER) + two additive `runs` columns. Attempt history on `RunDetail` and in `verdict.md`. |
| Default | OFF, behind `DASHBOARD_AUTO_RECOVER`, with `DASHBOARD_RATE_LIMIT_AUTO_RESUME` retained as an alias. §10 says why, and says plainly that turning it on is the owner's decision and that this spec's whole job is to make "on" safe. |

---

## 1. Measured ground truth

Read from the owner's own store (read-only copy at `/tmp/ro-runs-designlead.db`; the live DB and the
server on 4176 were never touched):

```
run_id                                   status phase resume rate_limited rate_limited_at retryAfterSec kind       gate_att suite
run-2026-07-29T23-28-46-665Z-3d4d1ccb     passed done   0        0            (null)         299048     seven_day    1      yes
run-2026-07-30T13-31-38-076Z-c228e63b     failed spec   0        0            (null)         253699     seven_day    0      no
run-2026-07-30T20-16-40-242Z-052c6e02     failed done   2        0            (null)         186234     seven_day    1      yes
run-2026-08-04T11-08-10-487Z-162b186d     failed spec   1        0            (null)         431997     seven_day    0      no
```

Five facts this table settles, and they matter more than the brief's narrative:

1. **`#rateLimited` has never executed on this machine.** `rate_limited` is 0 and `rate_limited_at` is
   null on every row. The rate-limit park is code that has never run in production. Everything this
   spec builds on top of it inherits that: it is well-tested at the unit level
   (`rate-limit-resume.test.ts`, 17 tests) and unproven at the refusal.
2. **The recorded `retryAfterSec` values are telemetry, not refusals** — written by `#noteRateLimit`
   (`orchestrator.ts:5470-5476`) from routine `limited:false` frames. They are 186 234 – 431 997 s
   (2.2 – 5.0 days) and every one reports `kind = seven_day`.
3. **5 days is representable.** 431 997 s = 4.32 × 10⁸ ms, comfortably under
   `RATE_LIMIT_RESUME_MAX_DELAY_MS = 2_147_483_647` (`orchestrator.ts:647`). The existing 32-bit guard
   therefore does **not** catch a weekly cap. With the flag on today, a refusal reporting that instant
   would arm a genuine multi-day unattended timer. §6.3 adds the ceiling that catches it.
4. **Two of three failures died in the spec phase**, both through the seat, both terminal.
5. `run-...-052c6e02` already carries `resume_count = 2` with zero refusals — so the existing
   auto-resume cap (`RATE_LIMIT_AUTO_RESUME_MAX_RESUMES = 3`, `orchestrator.ts:663`) was two-thirds
   spent by the plan and design parks before any rate limit existed. §7.2 fixes that.

### 1.1 Corrections to the brief (house rule 9)

- **"RATE LIMITING IS ALREADY UNDERSTOOD AND STILL MANUAL" is stale.** Automatic resume exists in HEAD:
  `RATE_LIMIT_AUTO_RESUME_ENV` (`orchestrator.ts:624`), the pure `planRateLimitResume` (`:717-780`),
  `#armRateLimitResume` (`:5557-5599`), a live timer map (`#rateLimitTimers`), and a boot re-arm sweep
  (`:1613-1633`). It is opt-in and OFF by default. What is genuinely missing is (a) the spec phase,
  which has no rate-limit exit at all, and (b) everything in §7-§9.
- **"one `resetsAt` … cannot distinguish the 5-hour window from the weekly cap"
  (`orchestrator.ts:613-617` and `:654-662`) is wrong.** The SDK reports the discriminator:
  `sdk.d.ts:4253` — `rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
  | 'seven_day_overage_included' | 'overage'`. It is captured (`claude-common.ts:219`), persisted
  (`runs.rate_limit_kind`, `db.ts:471`), written twice (`orchestrator.ts:5474`, `:5514`) — and then
  never passed into the decision: `RateLimitResumeInput` (`:670-682`) has no `kind` field. Both
  docblocks must be corrected by this work; leaving them is worse than the missing feature, because
  the next reader will re-derive a bound from a false premise.
- **`SeatCallError.retryable`'s doc comment over-claims.** `anthropic-seat.ts:88-89` says "True for 429
  and 5xx". On the only live path it is assigned the rate-limit boolean and nothing else
  (`subscription-caller.ts:2064-2076` passes `this.#rateLimit.limited`; `:2124-2131` passes the regex
  result). It carries zero information about 5xx or transport. §3.3 replaces it with a discriminant
  rather than reading a field whose name lies.
- **The status-completeness test does not test completeness.**
  `cron/cron-policy.test.ts:103-117` claims "IN_FLIGHT names every non-terminal status the wire can
  carry", and `cron-policy.ts:31-36` claims "adding a status to the contract breaks the test". Both are
  false: the test's `all` array (`cron-policy.test.ts:106-114`) is a hand-written literal. A status
  added to `ApiRunStatus` and forgotten in `IN_FLIGHT` leaves that test GREEN and cron would submit
  over a live run. This is the repo's signature defect (a probe that can only observe what it was
  told) sitting in the exact file this feature would have to edit. §8.4 requires fixing it *before*
  any status is added, with its own negative control.

---

## 2. The architecture, in one paragraph

`cron/cron-tick.ts:4-12` forbids a second `Orchestrator` or a second handle on `runs.db`, and
`TickDeps` is given only a fetch-shaped `http`, so a retry daemon is not merely discouraged, it is
unconstructible. Recovery therefore lives inside the one `Orchestrator`, and it uses the shape the
three existing parks already use — **return out of `#execute` without calling `#finish`, arm a timer,
persist the instant, re-arm the remainder on boot** (plan park `:1786-1794`; design-lock park
`:1838-1844`; rate-limit park `:1848-1852` / `:1873-1877` → `#rateLimited` `:5506`). `#start`'s
`finally` (`:1685-1693`) clears `#active` and calls `pump()`, and `pump()` (`:1304-1316`) starts the
next queued run only while `#active === null` — so a parked run costs the queue nothing and a timer
that fires cannot claim a second slot, because its only action is `resume()`, which requeues and pumps.

**Invariant R1 — nothing recoverable may reach `#finish`.** `#finish` (`:5772-5785`) calls
`#publishProject` *before* it emits the terminal status, and it does so for FAILED runs too (docblock
`:5790-5797`). Any recovery bolted on downstream of `#finish` inherits a half-build already copied into
`projects/<slug>/`, and is in any case unreachable because `resume()` refuses `isTerminal`
(`:1391`, `db.ts:415-417`) and `http.ts:1157-1170` turns that into 409 `not_resumable`. R1 is what makes
the rest of this design safe, and it has a corollary the implementer must not skip: if a recoverable
class can only be detected at `#start`'s catch (`:1675-1684`), that is a **bug in the phase seam**, not
a licence to recover post-`#finish`.

**Corollary R1a.** Because only unrecoverable classes reach `#start`'s catch,
`#recordUnmeasuredBacklog(runId, "infra", detail)` at `:1679` stays exactly where it is. Area 1's
"spurious infra backlog on every recovered run" hazard is defused by construction, not by suppression.

---

## 3. The failure classifier

A pure module, `dashboard/server/src/recovery-policy.ts`, with no import from `orchestrator.ts` and no
clock, no timer, no store. Two pure functions:

```ts
export type FailureClass =
  | "intentional"   // the owner or the server stopped it
  | "throttled"     // the provider refused; time is the only fix
  | "interrupted"   // the process died under the run; nothing is wrong with the run
  | "transient"     // a fault a byte-identical retry could survive  (RESERVED — see §3.4)
  | "structural"    // a byte-identical retry is futile
  | "graded";       // not a fault: the gate produced a verdict

/** Structured signals only. No Error, no message, no orchestrator types. */
export interface PhaseFailureSignals {
  readonly aborted: boolean;
  readonly abortReason: "cancelled" | "shutdown" | null;
  readonly seatKind: SeatFailureKind | null;   // §3.3
  readonly bakeoffCode: BakeoffErrorCode | null;
  readonly lastRateLimit: { readonly limited: boolean } | null;
}
export function classifyPhaseFailure(s: PhaseFailureSignals): FailureClass;

/** The thin adapter that extracts those signals. Also pure; the ONLY place an Error is read. */
export function signalsFor(error: unknown, signal: AbortSignal, row: Pick<RunRow, "rateLimited">): PhaseFailureSignals;
```

Order is load-bearing and is asserted by test: **abort first, then structural, then throttled, then
transient, then unclassified.** A classifier that checks "throttled" before "aborted" restarts runs the
owner deliberately stopped — `run-...-c228e63b` in the real store died with `Claude Code process
aborted by user`, and `orchestrator.ts:1815-1817` already records the lesson in its own words: *check
the SIGNAL, not the message*.

### 3.1 The classes, their signals, and their bounds

| Class | Signal (structured unless marked) | Where the signal lives | Bound | What happens |
|---|---|---|---|---|
| `intentional` | `signal.aborted` + `abortReasonOf(signal)` — an AbortSignal `reason` compared against the exported constants `ABORT_CANCELLED` / `ABORT_SHUTDOWN` | `orchestrator.ts:449-451`, `:463-464`, read at `:5706-5712` | **0**, unconditionally | `#aborted` as today. Shutdown leaves the row `running` on purpose (`:5714-5741`); cancel finishes `cancelled`. |
| `structural` | `error instanceof BakeoffError` → `error.code` in `{invalid_usage_shape, suite_not_audited, suite_hash_mismatch, unknown_config, unknown_model_price, unpriced_usage, ambiguous_price_window, invalid_effort, duplicate_usage_row, budget_exceeded, not_implemented}` — i.e. **every** `BakeoffErrorCode` | `contracts.ts:57-69`; the ceiling throw at `spec-agent.ts:1200-1211`; the freeze wedge at `spec-freeze.ts:264-273` | **0** | Fail terminally, and put `error.remediation` on the run's log. `describeError` (`orchestrator.ts:6259-6264`) already prefixes `[code]` and appends `fix:` for a `BakeoffError`; that string is the product. |
| `throttled` | PRIMARY: `SeatFailureKind === "throttled"`, itself set from `this.#rateLimit.limited`, which comes from `rateLimitFrom(info)` where `info.status === "rejected"` — an SDK field (`claude-common.ts:207`, `sdk.d.ts:4250-4256`). SECONDARY: `row.rateLimited` on the run. **FALLBACK (prose, see §3.2)**: the regex at `subscription-caller.ts:2122`. | `subscription-caller.ts:1974-1975` (event), `:2057-2076` (result-frame throw), `:2119-2133` (exception throw) | **3** automatic continuations, from `auto_continue_count`, plus the 6 h wait ceiling of §6.3 | Park `rate_limited` via `#rateLimited`; arm the existing ladder. |
| `interrupted` | `status === "running"` at `reconcileOnBoot` — the row itself, written by nothing else, because `#abandonedForShutdown` deliberately writes no terminal state (`:5714-5731`) | `orchestrator.ts:1567-1579` | **3**, same counter, and the counter is the crash-loop brake (§6.4) | Requeue directly (`queued`), no wait. |
| `transient` | **NONE TODAY.** See §3.4 — this is a deliberate empty allow-list, not an oversight. | — | 2, reasoned not measured | Nothing fires. Policy is unit-tested against an injected class. |
| `graded` | Never reaches the classifier: the gate returns a record, it does not throw (`#gatePhase` catches, `:4891-4909`); the build returns a discriminant (`:4774-4778`); the judge never throws (`judge.ts:265-266`, `:348-352`). | — | **0** | `#finish(passed ? "passed" : "failed")` at `:1933`, unchanged. |
| *(residual)* `unclassified` | Everything else that escapes a phase | `#start`'s catch, `:1675-1684` | **0** | Exactly today's behaviour, plus an attempt row recording the class. This is the evidence channel of §3.4. |

`unclassified` is not a member of `FailureClass`; it is `classifyPhaseFailure`'s absence of a match,
represented as `"structural"` with a separate `recorded: "unclassified"` note on the attempt row. The
implementer may prefer a seventh member; either is acceptable provided a residual fault **never
recovers** and **is always recorded**.

### 3.2 Where a signal is only prose, and why nothing better exists

One signal in the table is a regex on an error message: `subscription-caller.ts:2122`

```ts
const rateLimited = /rate.?limit|429|usage limit/i.test(message);
```

**It must stay, and it must stay confined to that line.** The subscription seat does not speak HTTP —
it drives the Claude CLI as a subprocess through the agent SDK, so when the SDK throws rather than
returning a result frame there is no status code, no `Retry-After` header and no typed error to read;
the only thing that survives is `Error.message`. There is nothing better to match on *at that layer*.

Three rules follow, and they are the whole reason this is tolerable:

1. **`#asCallError` is the only place in the program allowed to look at the message.** It converts the
   guess into a *typed* `SeatFailureKind` once. Everything upstream reads the type.
2. **The orchestrator never matches on prose.** `classifyPhaseFailure` takes `PhaseFailureSignals` and
   physically cannot see a message. This is enforced by the module boundary, not by discipline.
3. The prose match is the *fallback*. When the SDK reports a `rate_limit_event` with
   `status: "rejected"` first — the expected path — `this.#rateLimit.limited` is already true and the
   result-frame throw at `:2057-2076` carries the structured answer. The regex only decides cases where
   the SDK gave us nothing else.

Whether the SDK actually emits the rejected event before the failing result is **unverified on this
machine** (§12.2).

### 3.3 The typed discriminant — the one change in `bakeoff/`

`SeatCallError` (`anthropic-seat.ts:83-98`) gains a discriminant, and its `retryable` docblock is
corrected rather than deleted:

```ts
/** What kind of failure this was, decided at the layer that still has the evidence. */
export type SeatFailureKind = "throttled" | "protocol" | "transport" | "unknown";

export class SeatCallError extends Error {
  readonly status: number | null;
  readonly remediation: string;
  /**
   * HISTORICAL AND OVER-NAMED. On the subscription path this has only ever
   * carried "we think this was a rate limit" — see subscription-caller.ts:2064
   * and :2131, both of which pass the rate-limit boolean. Read `kind`.
   */
  readonly retryable: boolean;
  readonly kind: SeatFailureKind;
}
```

Assignment, both sites, structured first:

- `subscription-caller.ts:2057-2076` (result-frame failure):
  `this.#rateLimit.limited ? "throttled" : failure.startsWith("error_max_turns") ? "protocol" : "protocol"`.
  `error_max_turns` is an SDK result subtype, not prose. It is **`protocol` → `structural`**: retrying
  identically re-hits the same turn cap, and the remediation already tells the operator to raise
  `SEAT_MAX_TURNS_ENV`. Turning that into a call-level rung (the overflow ladder's shape) is a
  reasonable future change and is **out of scope** (§11.4).
- `subscription-caller.ts:2119-2133` (`#asCallError`): `rateLimited ? "throttled" : "unknown"`.
  Not `"transport"` — see §3.4. The auth-expiry case the remediation names ("a session that expired
  mid-run presents exactly like this") lives in `unknown`, and `unknown` never recovers.

**And one bug fix that is not cosmetic.** `subscription-caller.ts:2123` currently does

```ts
if (rateLimited) this.#noteRateLimit({ limited: true, retryAfterSec: null, kind: null, utilization: null });
```

Those nulls flow through `onRateLimit` → `orchestrator.ts#noteRateLimit` (`:5470-5476`) → `updateRun`,
**overwriting whatever good `retryAfterSec` / `rateLimitKind` the SDK telemetry had already recorded on
the row**. `planRateLimitResume` then returns `disabled` on the null (`:726-734`). The fix is to merge
rather than replace:

```ts
if (rateLimited) this.#noteRateLimit({ ...this.#rateLimit, limited: true });
```

If there was no prior telemetry it stays null and the planner refuses, which is correct. Without this
fix, shipping the spec-phase park produces a run that parks and then sits there for ever — the
pre-2026-08-04 defect wearing a new status.

### 3.4 `transient` has no signal, and that is the decision

There is currently **no structured way to tell a 503 from an expired auth session** on the subscription
path (§3.2), and the evidence base contains **zero observed transients**: four runs, three failures,
none from network or 5xx. Two options were weighed:

- *Treat the residual as transient.* Rejected. It would automatically retry auth expiry, retry harness
  bugs, and — because `#asCallError` collapses every non-rate-limit subprocess failure into one
  string — retry things nobody has ever seen, unattended, on the owner's quota. It inverts the
  discipline `planRateLimitResume` is built on (refuse rather than guess, five separate refusal arms,
  `:718-779`).
- *Ship the arm with an empty allow-list.* **Chosen.** `classifyPhaseFailure` has a `transient` branch,
  its bound is enforced, and both are unit-tested by injecting the class directly into
  `PhaseFailureSignals`. No real error maps to it. Every residual fault is recorded on its attempt row
  with `end_class = 'unclassified'` and the full `describeError` string, so the **next** real fault
  produces the evidence a signal would need.

The bound, when a signal exists, is **2**, and that number is reasoned rather than measured — the same
honesty `DEFAULT_SILENCE_WARN_MIN`'s docblock applies to itself ("n = 1"). Any comment stating it must
say so.

---

## 4. The boundary with the existing call-level ladder

This is the question that decides whether the feature ships as "retries 9 times, reports 3".

**The rule, stated once:** *the call level owns "the same request with a different parameter"; the
phase level owns "the same phase, later". They never both own a class.*

| Level | Owns | Budget | Where |
|---|---|---|---|
| Call | output-token overflow: one rung, 64 000 → 128 000, retried **without consuming an authoring attempt** via the `truncationRetried` latch | exactly 1, spent inside the call | `spec-agent.ts:1186-1198`; ceilings at `spec-types.ts:230`, `:249`, `:309` |
| Call | authoring/audit attempts (`maxAttempts`) | as configured | `spec-agent.ts` authoring loop |
| Phase | `throttled`, `interrupted` | 3, `auto_continue_count` | this spec |
| Phase | gate fix rounds | 3 **per run**, not per entry (§7.4) | `gate-fix-loop.ts:45`, `:75-88` |

**How the phase level learns what the call level already spent — it does not need to, and that is the
design.** The call level converts an exhausted ladder into a `BakeoffError` before it ever leaves:
`spec-agent.ts:1200-1211` throws `invalid_usage_shape` with the remediation *"regenerating cannot fix
it — there is no higher max_tokens to retry at"*. `classifyPhaseFailure` maps **every**
`BakeoffErrorCode` to `structural`, bound 0. So the phase level does not count the call level's
attempts; it observes that the call level declared the failure unrecoverable and stops. No shared
counter, no cross-layer accounting, no possibility of multiplication — because the two levels never
attempt the same thing.

The corollary the implementer must not undo: **a phase-level retry must never be keyed on
`error.message`.** The 2026-08-04 death's message contains "exceeded the 64000 output token maximum". A
message-keyed retry would re-run a 50-minute spec phase against a ceiling that cannot move, three
times, and report one.

`suite_not_audited` (three authoring attempts exhausted) is likewise `structural`. So is the freeze
wedge: a `FROZEN.json` that exists but fails `assertSuiteIntact` is swallowed to `existing = null`
(`orchestrator.ts:2436-2440`) and the re-freeze then throws on `existsSync(manifestPath) && overwrite
!== true` (`spec-freeze.ts:264-273`). Every retry hits the identical throw with zero success
probability; §9.5 makes a test prove it is refused.

---

## 5. What is reused on a continuation

**Rule C1 — a continuation re-enters the SAME `run_id`. Never a new row.** Everything expensive is
keyed to survive that and nothing is keyed to survive a new row: `#execute` re-derives the ticket from
the stored (already amended) `ticketText` plus the per-run reference manifest (`:1741-1748`) rather than
trusting `row.ticketId`; `plan.json` lives under `runs/<runId>/results/`, so a new row re-asks the
dialogue and mints a different amended ticket id; and a different ticket id misses
`assertSuiteIntact` and authors a second suite. Area 2 re-ran the id derivation against all four real
runs and reproduced the stored `ticket_id` for every one, including the two carrying reference
manifests.

### 5.1 What each phase reuses, and at what cost

| Phase | On re-entry | Cost | Mechanism |
|---|---|---|---|
| plan | Short-circuits on `plan.json` `folded:true`; and a run with `suiteSha256` set never plans at all | zero | `orchestrator.ts:1986-1991`, `:2033-2040` |
| spec | Reuses the intact freeze by digest, logs `reusing the sealed acceptance suite…`, re-records criteria, returns with **no seat call** | zero | `:2432-2451` |
| design | `nextBuildSegment` is a pure function over durable inputs (`designSegmentDone` on the row, the workspace manifest, `design-lock.json`); a second lock is **refused**, not silently applied | zero | `build-segment.ts:60-120`; `design-lock.ts:114-119` |
| build | Same session: `#rateLimited` persists `builderSessionId` (`:5515`) and `#buildPhase` passes it as `resumeSessionId` (`:3339`), which the driver maps to the SDK's `resume:` | near-zero | `builders/claude-builder.ts` |
| gate | Frozen suite unchanged; criteria upsert deliberately does **not** clobber `result`/`detail` | zero | `db.ts:1206-1219` |

### 5.2 The frozen suite — the honest answer to "must not re-author"

**A continuation cannot re-author a frozen suite.** Two independent mechanisms, either of which alone
would be sufficient:

1. `#specPhase` calls `assertSuiteIntact(ticket.id, { acceptanceRoot })` **first** and returns the
   existing suite without a seat call (`:2436-2451`).
2. If that were bypassed, `authorAndFreezeSuite` is invoked with `overwrite: false` (`:2540`), and
   `freezeSuite` throws on an existing manifest (`spec-freeze.ts:264-273`). Replacement is not a code
   path that exists.

So a recovered run is graded against the same yardstick as the run that started, and a recovered
`heldOutPass` means exactly what a clean one means.

**The case the question is really about, stated plainly:** a run that dies *in* the spec phase has **no
frozen suite** — `run-...-162b186d` has `suite_sha256 = NULL` and no `acceptance/<id>/FROZEN.json`
(Area 2 ran `verifySuiteIntact` on all four ticket ids: `intact=true` with a sha matching
`runs.suite_sha256` for the two that completed spec, `intact=false / missing_manifest` for the two that
died in it). A continuation of that run **authors a suite for the first time**, at a cost of roughly
the 51 minutes the phase takes. That is not re-authoring, there is no earlier yardstick to differ from,
and no grading exists that would be invalidated. Under "tokens are cheap, context loss is not", paying
it is correct — it buys back the plan dialogue, the amended brief, the attached documents and the
reference manifest, all of which are durable and all of which a new run would re-ask for.

`freezeSuite` writes the suite files before `FROZEN.json` and chmods last (`spec-freeze.ts:356`,
`:378-389`), so a crash mid-freeze leaves **no manifest** and the next attempt authors cleanly. The only
bad state is a manifest that exists and does not verify, which is `structural` (§4).

### 5.3 The two things a continuation inherits that are claims, not files

- **`.bakeoff/self-report.json`.** Read after the build segment to set `agentDeclaredDone`
  (`:1854-1863`), which is what `falseFinish` is computed against (`:1936`). **Decision: it is
  inherited, not deleted.** A continuation always resumes the *same* builder session
  (`builderSessionId` survives every park), so the declaration is from the same continuous piece of
  work; deleting it would let a run that genuinely declared done and failed the gate report
  `falseFinish = false`, i.e. **hide** a false finish. Over-reporting a declaration is the safer
  direction in this repo. The attempt row records `self_report_inherited` so `verdict.md` can say so.
  This is a judgement call and is listed in §12.4.
- **The workspace itself.** There is no checkpoint to roll back to: both real workspaces have exactly
  one commit, `workspace created`, and the passed run's artefact is merely *staged* by `workspaceDiff`
  for the judge's benefit. `git reset --hard` would destroy the build. The workspace is therefore
  **cumulative across attempts by definition**, `ensureRunDirs` is `mkdir -p` only (`paths.ts:225-229`),
  and the scorer stages everything except `.git/.hg/.svn/.jj/.bakeoff` (`scorer.ts:333-339`). This is
  already true inside the existing 3-round fix loop; recovery widens the window rather than opening it.
  §9.6 requires the record to say the artefact is cumulative rather than pretending otherwise.

---

## 6. The wait

### 6.1 The shape (unchanged, because it is already correct)

A `throttled` run **returns out of `#execute` without `#finish`**, which releases `#active` in
`#start`'s `finally` (`:1685-1693`) and re-pumps. The queue drains past it. This was measured by Area 3:
a run parked on a 45-minute armed wait alongside a queued run left `activeRunId = run-B-queued` and run
B `running`.

**The trap, named so nobody re-implements it:** `await sleep(delayMs)` inside `#execute` holds
`#active` for the whole window and stops the queue dead — indistinguishable from a stopped server,
which is the exact thing "context loss is not ok" is protecting against. The wait must be off the
stack.

The timer's only action is `resume()` (`:5590-5594`) — inheriting every refusal (terminal rows, the
active run), the requeue, and a `pump()` that respects `#active`. Nothing shortcuts into `#start`.

### 6.2 The spec phase gets the exit it lacks

At `orchestrator.ts:1801-1820` the catch checks `signal.aborted` and rethrows everything else. Add one
arm, **between** the abort check and the rethrow, keyed on `classifyPhaseFailure`:

```ts
} catch (error) {
  if (signal.aborted) return this.#aborted(runId, log, signal);
  const klass = classifyPhaseFailure(signalsFor(error, signal, store.getRun(runId)!));
  if (klass === "throttled") {
    log.close();
    // THE STATE COMES OFF THE ROW, not out of a field on the error and not out
    // of an in-memory map that does not exist. `#noteRateLimit` (:5470-5476) has
    // already written rateLimitRetryAfterSec and rateLimitKind from the SDK's own
    // telemetry, and after the §3.3 merge fix the regex path no longer nulls them.
    const r = store.getRun(runId)!;
    // NO SESSION ID, AND THAT IS CORRECT. Spec continuity is the FROZEN SUITE
    // (assertSuiteIntact at :2436), not a resumable builder session; #rateLimited's
    // sessionId argument exists for the build lane and is null here on purpose.
    this.#rateLimited(
      runId,
      { limited: true, retryAfterSec: r.rateLimitRetryAfterSec, kind: r.rateLimitKind, utilization: null },
      null,
    );
    return;
  }
  throw error;
}
```

The bound is **not** checked here. `#rateLimited` parks unconditionally — a refused run must stop
whatever happens — and `#armRateLimitResume` (`:5557`) already asks `planRateLimitResume` whether to
arm, which is where `AUTO_CONTINUE_MAX` lives. One decision point, not two.

Two halves that fail independently, and both are required (§9.1): the park, and the `retryAfterSec`
merge fix of §3.3 without which the park arms nothing.

### 6.3 The wait ceiling — new, and the 32-bit guard does not substitute for it

`RATE_LIMIT_RESUME_MAX_DELAY_MS` (`:632-647`) refuses a delay that `setTimeout` cannot represent. A
five-day `seven_day` window is representable (§1, fact 3), so it sails through. Add:

```ts
/**
 * The longest wait auto-recovery will arm unattended, and why it is SEPARATE
 * from RATE_LIMIT_RESUME_MAX_DELAY_MS.
 *
 * That constant refuses a delay this PROGRAM cannot hold. This one refuses a
 * delay the OWNER did not agree to hold. Measured on this machine, every
 * rate_limit frame ever recorded reports kind `seven_day` with a reset 2.2-5.0
 * DAYS out (runs.db, 2026-08-05) — 4.32e8 ms, comfortably under the 32-bit
 * ceiling. Without this the first real refusal arms a five-day unattended timer.
 *
 * Six hours, because it covers a five-hour rolling window plus slack, which is
 * the wait the owner described as cheap. A longer one parks and SAYS its length.
 */
export const RECOVERY_MAX_AUTO_WAIT_MS = 6 * 60 * 60 * 1000;
export const RECOVERY_MAX_WAIT_ENV = "DASHBOARD_RECOVERY_MAX_WAIT_MIN";
```

`planRateLimitResume` gains two inputs, `kind: string | null` and `maxWaitMs: number`, and one refusal
arm placed **after** the 32-bit arm:

> `the provider reported a <kind> window that reopens in <N> h, longer than the <M> h this server will
> wait unattended. The run is kept and resumes the moment you press Resume; raise
> DASHBOARD_RECOVERY_MAX_WAIT_MIN to let it wait by itself.`

This also discharges the corrected docblock of §1.1: with `kind` in the input, the resume cap no longer
needs to justify itself by a distinction the SDK does report.

### 6.4 `interrupted`: the boot path

`reconcileOnBoot`'s first loop (`:1567-1579`) moves every `running` row to `awaiting_input` and tells
the owner to POST `/resume`. A mid-build interruption with no plan park and no design park then falls
through the second loop's two `continue`s (`:1600`, `:1602`) and has **no automatic exit at all**. This
is the largest "not self-maintaining" hole in the system and it is bigger than the retry feature.

Decision: when auto-recovery is on, the first loop writes `queued` and increments
`auto_continue_count` instead of `awaiting_input`; when it is off, today's behaviour, unchanged, with
today's sentence.

**The crash-loop brake is the counter, and it is the only thing standing between this and a boot
loop** (boot → queue → start → crash → process dies → supervisor restarts → boot). At
`auto_continue_count >= 3` the run goes to `awaiting_input` with a sentence naming the count. The
existing rate-limit sweep is safe from this only because it arms a timer rather than starting a run;
the boot requeue has no such brake and must carry its own.

**Do not let the recovery sweep touch `awaiting_input`.** That set contains runs parked for the
owner's answer. `reconcileOnBoot`'s second loop already gates on the durable park records
(`PlanDriver.reconcile`, then `design-lock.json`'s `awaiting`) precisely because status alone cannot
tell them apart, and the comment at `:1592-1599` records that omitting the plan branch reintroduced the
very defect the loop exists to prevent. Recovery adds nothing to that loop.

### 6.5 The bound, in one place

```ts
export interface RecoveryBoundInput {
  readonly klass: FailureClass;
  readonly autoContinueCount: number;   // NOT resumeCount — see §7.2
  readonly enabled: boolean;
}
export const AUTO_CONTINUE_MAX = 3;
export function mayAutoContinue(i: RecoveryBoundInput): { ok: true } | { ok: false; reason: string };
```

One counter for all classes, because the failure mode to fear is a run bouncing between classes for
ever. A run that waited out one window and was then interrupted by a restart has one continuation left,
and its log says so.

Two call shapes, one constant and one column: `planRateLimitResume` enforces it for `throttled` (via
its renamed `autoContinueCount` input, §7.2), and `reconcileOnBoot` calls `mayAutoContinue` directly for
`interrupted`. They must not each keep their own number — the shared export is the whole point, and
negative control 8 mutates it once and expects both tests to move.

---

## 7. What the record says

### 7.1 The attempt table (needs no ALTER)

Appended to `SCHEMA` (`db.ts:447`). A new **table** is free on an existing database:
`CREATE TABLE IF NOT EXISTS` creates it empty, and the four historical runs get zero rows.

```sql
CREATE TABLE IF NOT EXISTS run_attempts (
  run_id                TEXT    NOT NULL,
  attempt_no            INTEGER NOT NULL,          -- 1-based
  started_at            TEXT    NOT NULL,
  ended_at              TEXT,
  phase_reached         TEXT    NOT NULL,
  end_class             TEXT,                      -- FailureClass | 'unclassified' | 'completed'
  end_detail            TEXT,                      -- describeError(), redacted, or null
  waited_sec            INTEGER,                   -- wall clock waited BEFORE this attempt began
  suite_source          TEXT,                      -- 'authored' | 'reused' | 'none'
  self_report_inherited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS run_attempts_run ON run_attempts (run_id, attempt_no);
```

**Zero rows means "this run predates the feature", never "one clean attempt."** Every reader — the
wire, `verdict.md`, the client — must render an empty history as *nothing*, not as *"1 attempt"*. That
rule is why there is no `attempt_count` column: a `DEFAULT 1` would be a false claim about
`run-...-052c6e02`, which had three entries into `#execute` (`resume_count = 2`), and `db.ts:640-643`
requires every default to be true of every historical row.

`suite_source` is written from the branch actually taken in `#specPhase` — `'reused'` at the reuse
return (`:2446-2450`), `'authored'` at the freeze write-back (`:2558-2566`), `'none'` if the phase did
not complete. It is not inferred from the log line,
even though `graph.ts:453` already folds `/^reusing the sealed acceptance suite/i`: a machine-readable
column and a prose fold that agree is fine, a prose fold alone is not a record.

### 7.2 The `runs` columns (two, both additive)

Appended to the `SCHEMA` literal (`db.ts:447`), the `RUN_COLUMNS` join list (`:588`), and
`ADDED_RUN_COLUMNS` (`:644`), plus the `RunRow` type and reader (`~:1503-1529`) and `updateRun`'s
setter (`:982` pattern). **Five touch points, not one** — the docblock at `db.ts:629-643` explains that
omitting the third breaks only the owner's machine, because every test starts from `mkdtemp` where
`CREATE TABLE IF NOT EXISTS` always has the newest column. This has already happened once, with
`design_lock`.

```sql
-- Auto-recovery. `auto_continue_count` is NOT NULL DEFAULT 0 on gate_attempts'
-- reasoning: 0 is a real count that happens to mean "none", and it is TRUE of
-- every historical row — no run has ever continued itself, because until this
-- change nothing could.
ALTER TABLE runs ADD COLUMN auto_continue_count INTEGER NOT NULL DEFAULT 0;
-- `recovery_class` is NULLABLE WITHOUT A DEFAULT on gate_stop_reason's and
-- rate_limited_at's reasoning: there is no value that means "we know why this
-- historical run stopped", and any word we chose would be a claim.
ALTER TABLE runs ADD COLUMN recovery_class TEXT;
```

**No `recovery_fires_at` column.** The armed instant is derived in `http.ts` from
`rateLimitedAt + retryAfterSec`, exactly as `#armRateLimitResume` derives it (`:5582`). One source of
truth, and it preserves the discipline that a re-arm always computes from the ORIGINAL instant — the
thing `planRateLimitResume:744-753` exists to protect ("Arming from now would restart the whole window
on every boot").

**`auto_continue_count` replaces `resumeCount` as the auto-resume cap's input.** `resume()` increments
`resumeCount` unconditionally (`:1546`) and six internal callers use it for the plan and design parks,
so `run-...-052c6e02` reached 2-of-3 with zero refusals. `RateLimitResumeInput.resumeCount`
(`:670-682`) becomes `autoContinueCount`, and the docblock paragraph at `:653-662` beginning "IT COUNTS
THE OWNER'S RESUMES TOO" is rewritten to say that it no longer does. `resumeCount` stays as the
owner-facing total. This loosens the bound for a run the owner has resumed by hand, which is correct:
the bound exists to limit **unattended** spend, and an owner resume is attended.

### 7.3 Where the attempt row is written

- **Opened** at the top of `#execute` (`:1696`), immediately after the row is read and before any
  phase: `attempt_no = max + 1`, `started_at`, `waited_sec` computed from the previous attempt's
  `ended_at`.
- **Closed** at exactly five sites, all of which already exist and all of which are the ends of an
  entry into `#execute`: the three `#finish` calls (`:1680`, `:1911`, `:1933`), `#rateLimited`
  (`:5506`), and each non-terminal park return (`:1786-1794`, `:1838-1844`).
- `phase_reached` comes from the row, which `#setPhase` (`:5889-5892`) already persists at every
  boundary.

### 7.4 Attempt multiplication — fixed here or not at all

`maxAttemptsFrom(env)` is re-read on every `#execute` entry (`:4669`), `runGateFixLoop` restarts its
numbering at 1 each time (`:4633-4638`), and `:4706` **overwrites** `gateAttempts`. N continuations
therefore grant 3N fix rounds and the row reports the last entry's count. This exists today, inside the
manual resume path; recovery would multiply it silently.

Two changes:

1. `:4706` accumulates: `gateAttempts: row.gateAttempts + result.attempts`. Its docblock at `:4695-4706`
   currently states the overwrite is deliberate ("It is patched again when the run resumes"); that
   paragraph is replaced, not deleted, with the reason for the new behaviour.
2. The budget becomes per-run: `maxAttempts: Math.max(1, maxAttemptsFrom(env) - row.gateAttempts)`.
   `Math.max(1, …)` because the gate must be able to run once to produce a verdict — with the fix
   budget spent, a continuation gates once and does not fix. This changes the manual-resume path too
   and the owner should be told: if he wants more rounds he raises `DASHBOARD_GATE_MAX_ATTEMPTS`, which
   `gate-fix-loop.ts:75-88` already refuses to clamp silently.

---

## 8. The wire, and what the dashboard shows

### 8.1 `ApiRunRecovery` on `RunDetail`

`ApiRateLimit` (`api-types.ts:268-271`) carries `{limited, retryAfterSec}` and nothing else;
`rateLimitedAt`, `rateLimitKind` and `resumeCount` are columns that appear nowhere on the wire; the
armed instant exists only interpolated into a log string (`:5582-5589`). `retryAfterSec` is a
**duration measured from an instant the client cannot see**, so the client cannot render "until 14:20"
and the number goes stale the moment the page is open. Add, built in `http.ts` beside `:626`:

```ts
/**
 * WILL THIS RUN PICK ITSELF UP, WHEN, AND IF NOT — WHY NOT.
 *
 * `null` MEANS "NOTHING IS ARMED", NEVER "HEALTHY" — the same rule
 * ApiRunSilence states at api-types.ts:288-296, for the same reason. A UI that
 * renders null as a green tick has invented a check nobody performed.
 *
 * `firesAt` IS AN INSTANT, NOT A DURATION, on ApiRunSilence.since's stated
 * lesson (api-types.ts:314-320: "It is a snapshot and it does not tick"). A
 * "45 min" badge on a page open for two hours is indistinguishable from a hang,
 * which is the confusion this object exists to remove.
 */
export interface ApiRunRecovery {
  readonly klass: "throttled" | "interrupted" | "transient";
  readonly armed: boolean;
  readonly firesAt: string | null;       // derived: rateLimitedAt + retryAfterSec
  readonly window: string | null;        // runs.rate_limit_kind, e.g. "seven_day"
  readonly attempt: number;              // auto_continue_count + 1
  readonly cap: number;                  // AUTO_CONTINUE_MAX
  readonly blockedReason: string | null; // planRateLimitResume's own `reason`, which today reaches only a log line
}

export interface ApiRunAttempt {
  readonly attemptNo: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly phaseReached: ApiRunPhase;
  readonly endClass: string | null;
  readonly endDetail: string | null;
  readonly waitedSec: number | null;
  readonly suiteSource: "authored" | "reused" | "none" | null;
}
```

`RunDetail` gains `recovery: ApiRunRecovery | null` and `attempts: readonly ApiRunAttempt[]`.
`contract-parity.test.ts` compares `RunDetail` field sets in both directions across the package
boundary, so the mirror at `dashboard/src/lib/api-types.ts` must be updated in the same change or the
build goes red — which is the point.

### 8.2 The states, named

| What the owner is looking at | How it is distinguished |
|---|---|
| **waiting until 14:20, attempt 2 of 3** | `status = rate_limited`, `recovery.armed = true`, `recovery.firesAt` an instant, `recovery.attempt`/`cap` |
| **stopped on a rate limit, and nothing will pick it up** | `status = rate_limited`, `recovery.armed = false`, `recovery.blockedReason` non-null and quotable verbatim |
| **restarting after a server restart** | `status = queued`, `recovery.klass = "interrupted"`, attempt row with `end_class = 'interrupted'` |
| **parked for the owner's answer** | `status = awaiting_input` + the plan/design park records (unchanged) |
| **running and has said nothing for 3 h** | `status = running`, `silence.overThreshold` (`api-types.ts:288-330`, unchanged and still report-only) |
| **hung and unwatched** | `status = running`, `silence = null` — a bug, not health |
| **failed after 3 attempts** | terminal status + `attempts.length > 1` (§9) |

### 8.3 Cancel must disarm — a live falsehood, fix it first

`cancel()` (`:1366-1379`) clears `#plan.clearTimer` and `#clearDesignLockTimer` and does **not** call
`#clearRateLimitTimer`. Two investigators reproduced the consequence independently with probes and
inverse controls: the armed timer fires later on a `cancelled` run, writes *"the reported rate-limit
window has elapsed; resuming automatically"*, and then `resume()` silently refuses the terminal row —
so the sentence is false. This is verbatim the defect `cancel()`'s **own docblock** narrates for the
design timer in round 5 on 2026-08-03 (`:1349-1358`), reintroduced one park down; the docblock still
says "AND THERE ARE TWO OF THEM" while there are three.

This is one line, it is a lie the automation writes today, and adding a second armed park before fixing
it doubles it. **It ships first, in its own commit, with the test.**

### 8.4 The `recovering` status — deferred, and here is exactly what it costs

Not needed in v1: `throttled` reuses `rate_limited` (already on the wire, already understood by the
client, and the sentence is true), and `interrupted` requeues immediately with no wait. It becomes
necessary the day `transient` gets a signal, because a short backoff needs a state that is neither
"the provider refused" (false) nor "a human has to decide" (false).

When that day comes, the price is **four hand-written lists, three of which no test forces**:

1. `api-types.ts:81-89` — the union.
2. `db.ts:350-358` `RUN_STATUSES` — module-private, and the row reader `oneOf`s against it (`:1508`),
   so a status written but not listed throws `invalid_usage_shape` on read.
3. `cron/cron-policy.ts:38` `IN_FLIGHT` — a status missing here is treated as terminal and **cron
   submits over a live run**.
4. `dashboard/src/lib/api-types.ts:1518-1526` — the client's set. Benign by design: an unrecognised
   value renders a neutral badge and never throws (`:1512-1517`).

`isTerminal` (`db.ts:415-417`) must NOT include it.

**Prerequisite, and it is not optional.** Before any status is added,
`cron/cron-policy.test.ts:103-117` must stop enumerating statuses by hand (`:106-114`) and derive them
from an exported runtime list — export `RUN_STATUSES` from `db.ts:350` (or move the canonical list to
`api-types.ts`) and have both `db.ts` and the test read it. Today that test's own comment claims it
catches this and it does not. Negative control: add a member to `ApiRunStatus`, leave `IN_FLIGHT`
alone — the test must go RED. It currently stays green.

---

## 9. The honesty requirement

**A run that needed three attempts must not present itself as a clean pass.** This is a hard
requirement, not a nicety: the record is the entire value of this program, and a recovery feature that
launders its own failures destroys more than it saves.

Attempt history surfaces in exactly four places, and all four are required:

1. **`RunDetail.attempts`** (§8.1) — the machine-readable record, one row per entry into `#execute`.
2. **`verdict.md`** — `#writeVerdict` (`:5752-5771`) is the single funnel for every terminal status and
   is the document the owner reads. When `attempts.length > 1` it gains a section, above the verdict,
   of the shape:

   > **This run took 3 attempts.** Attempt 1 stopped in `spec` on the provider's rate limit and waited
   > 4 h 12 m. Attempt 2 stopped in `build` when the dashboard restarted. Attempt 3 completed. The
   > acceptance suite was authored on attempt 1 and reused unchanged on attempts 2 and 3
   > (`21c30afd…`). The workspace is cumulative across all three; the builder's self-report was
   > inherited from attempt 2.

   Every clause is read from `run_attempts`; none is inferred.
3. **The run's own log**, at the moment of each decision — already the pattern
   `#armRateLimitResume:5566-5589` establishes, and `planRateLimitResume`'s docblock states that the
   `disabled` reason **is the product**. Both outcomes are announced: an armed wait names its instant,
   a refusal names its reason. Silence is the one thing this must never produce.
4. **The events table**, which is already the authoritative durable narrative (`db.ts:1011-1018`;
   `appendEvent` is a synchronous INSERT on every emit, and the 12-hour run has 1301 rows).

What is deliberately **not** changed: `heldOutPass`, `falseFinish` and the terminal status keep their
current meanings. A recovered run that passes is a pass — graded against the same frozen suite (§5.2).
The number of attempts is reported *beside* the verdict, never folded into it.

---

## 10. The flag, and the owner's decision

One env var, `DASHBOARD_AUTO_RECOVER`, governing all classes;
`DASHBOARD_RATE_LIMIT_AUTO_RESUME` (`orchestrator.ts:624`) is retained as an alias that enables
`throttled` alone, so an existing launchd plist keeps working. Unrecognised values are OFF, inverting
`designLockPolicy`'s rule for the reason already written at `:620-622`: here the safe direction is the
one that does not spend.

**Default OFF, and I am not going to pretend otherwise.** But the owner asked for automation, and the
honest framing is this: default-OFF exists because an automatic resume spends his subscription with
nobody watching *and nothing tells him it is happening*. §8 removes the second half — with
`recovery.firesAt`, `recovery.attempt/cap`, `recovery.blockedReason` and the attempt history, an armed
wait is visible, bounded, capped at 6 h unattended, and legible after the fact. That is what makes
"on" a reasonable setting rather than a gamble. **Recommend to the owner that he set
`DASHBOARD_AUTO_RECOVER=1` once §8's wire lands, and say so as a one-line recommendation rather than
shipping a changed default.**

---

## 11. Out of scope, and why

1. **A graded failure.** `run-...-052c6e02` ran 12 hours and scored 0/16. It did not throw — it
   `#finish`ed at `:1933` with a real verdict. Re-running it would produce four identical zeros over 48
   hours. **Only a thrown, classified fault may recover; a verdict never does.** A classifier written
   against `status` rather than against a classified exception would do exactly this.
2. **Output-token overflow.** Owned by the call level, one rung, already repaired and proven live with
   two applied-and-reverted mutations (`spec-ladder-e2e.test.ts:1-56`). Nothing at the phase level.
3. **`error_max_turns`.** A call-level ladder rung (raise `SEAT_MAX_TURNS_ENV` and re-dispatch) would
   be the right shape. Not built here; `structural` for now, with the remediation surfaced.
4. **Auth expiry.** Indistinguishable from a generic subprocess failure today
   (`subscription-caller.ts:2128-2131` says so in its own remediation). Retrying it burns quota to
   reproduce a failure a human must clear. `unknown` → never recovers.
5. **The freeze wedge.** A `FROZEN.json` that exists and fails integrity is permanently unrecoverable
   (§4). Automating it is a runaway with zero success probability. A future repair is a *repair* — an
   explicit re-freeze with `overwrite: true` behind an owner action — not a retry.
6. **New run rows.** Rule C1 (§5). A retry that mints a new row loses `plan.json`, re-asks the
   dialogue, mints a different amended ticket id, misses `assertSuiteIntact`, and authors a second
   suite — grading the retry against a yardstick the original never saw.
7. **Any second process, and the cron.** §2.
8. **Killing or preempting a run on suspicion.** The silence watch stays report-only
   (`api-types.ts:288-296`; doc 03 §7.8: 79% of unresolved runs time out while still making progress).
   Nothing in this feature terminates anything.
9. **Whether a refused call consumes quota.** Unknowable from here and not worth a live refusal to
   find out. The `utilization` field that would answer it is parsed (`claude-common.ts:220`) and
   discarded — §12.3.

---

## 12. Genuinely inconclusive — do not let the implementation paper over these

1. **Zero observed transients.** Four runs, three failures: one abort, one output-token ceiling, one
   graded zero. Nothing in the evidence would have been saved by a transient retry. The bound of 2 is
   reasoned; any comment stating it must say so.
2. **The refusal path has never executed in production.** `rate_limited = 0` and
   `rate_limited_at = NULL` on all four runs; 29 `rate_limit` events, **zero** with `limited: true`.
   Consequences that stay open: whether the SDK emits a `rejected` frame before the failing result
   (which decides whether §3.2's prose fallback is the common path or the rare one); and whether a real
   refusal reports `five_hour` or `seven_day` — every frame ever recorded here says `seven_day`, so the
   6 h ceiling of §6.3 may refuse *every* real refusal, or none.
3. **Whether a refused call consumes quota** is unanswerable from this repo. Persist `utilization`
   (currently dropped at `claude-common.ts:220`) and the next genuine refusal answers it at zero cost.
4. **Self-report inheritance** (§5.3) is a judgement call between over-reporting `falseFinish` and
   hiding it. This spec chooses over-reporting. If the owner disagrees the change is one line plus the
   attempt-row flag.
5. **The per-run gate budget** (§7.4) changes the manual resume path's behaviour, not only the
   automatic one. Flagged for the owner rather than decided silently.
6. **End-to-end recovery cannot be proven without an injected failure harness.**
   `rate-limit-resume.test.ts:35-45` says so about itself: every run there is seeded into
   `rate_limited` through the store, and *"that the instant is WRITTEN at the refusal is proved by
   nothing"*. `OrchestratorDeps.makeBuilder` / `makeGate` injection exists (`:310`, `:357`); driving a
   phase to a classified throw needs a fake wired through them, and that is the single largest
   implementation cost in this feature. **No live run is to be triggered for any of it.**

---

## 13. Build sequence

### Stage A — pure policy, no orchestrator dependency (`recovery-policy.ts` + `recovery-policy.test.ts`)

Provable with no run, no clock, no timer, no store. Modelled byte-for-byte on `planRateLimitResume`'s
discipline: default-safe, every arm reachable from a unit test, and the refusal REASON is the product.

- `FailureClass`, `PhaseFailureSignals`, `classifyPhaseFailure`, `signalsFor`.
- `AUTO_CONTINUE_MAX`, `mayAutoContinue`.
- `RECOVERY_MAX_AUTO_WAIT_MS`, `RECOVERY_MAX_WAIT_ENV`, `recoveryMaxWaitMs(env)`.
- `planRateLimitResume` extended with `kind` and `maxWaitMs`, and its input renamed
  `resumeCount → autoContinueCount`. **It is extended, not duplicated:** one wait computation, so a
  second ladder cannot drift from the first.

### Stage B — the one-line truth fix

`cancel()` calls `#clearRateLimitTimer(runId)`; the `:1341-1358` docblock's "AND THERE ARE TWO OF THEM"
becomes three, with the measured probe recorded in it the way round 5's incident is. Ships alone.

### Stage C — the call layer

`SeatFailureKind` on `SeatCallError` (`anthropic-seat.ts:83-98`), assigned at both throw sites, plus
the `retryAfterSec`-clobber merge fix (`subscription-caller.ts:2123`). The `retryable` docblock is
corrected in place.

### Stage D — the record

`run_attempts` + the two `runs` columns, all five `db.ts` touch points, and a migration test that
reproduces the old schema with `DROP COLUMN` and reopens — the shape
`rate-limit-resume.test.ts:212-235` already uses for `rate_limited_at`. Attempt rows opened and closed
at the six sites of §7.3.

### Stage E — the wire

`ApiRunRecovery` / `ApiRunAttempt` on `RunDetail`, built in `http.ts` beside `:626`, mirrored in
`dashboard/src/lib/api-types.ts`, with `contract-parity.test.ts` as the enforcement. `verdict.md`'s
attempt section.

### Stage F — the orchestrator arms

The spec-phase throttle exit (§6.2); the boot requeue (§6.4); the counter switch; the per-run gate
budget (§7.4); `DASHBOARD_AUTO_RECOVER`.

Stages A-E are unattended-safe and spend nothing. Stage F is the one that needs the owner's decision
about the default.

---

## 14. Negative controls

House rule 1: every one of these must be **applied to production code, watched red, reverted, watched
green**, and both results reported. A retry test that passes whether or not the retry happened is the
single most likely way this feature ships broken.

| # | Class / concern | Mutation to production code | Test that must turn RED |
|---|---|---|---|
| 1 | `throttled`, spec phase — the park | Delete the `#rateLimited` arm from the spec catch (`:1801-1820`) | "a spec-phase rate limit parks the run `rate_limited` and does not finish it `failed`" |
| 2 | `throttled`, spec phase — the wait | Keep the arm; restore `retryAfterSec: null` in `#asCallError` (`subscription-caller.ts:2123`) | "a timer is ARMED after a spec-phase refusal" goes red **while test 1 stays green**. Two mutations because the two halves fail independently, and shipping only the first produces a run that parks for ever. |
| 3 | `intentional` | Force `classifyPhaseFailure` to return `"throttled"` unconditionally | "a cancelled run is NOT auto-continued" |
| 4 | `intentional`, ordering | Move the abort check after the throttle check in `classifyPhaseFailure` | Same test as 3, driven with an abort whose message contains "rate limit" |
| 5 | `structural` / the CAPPED trap | Make the phase classifier map `BakeoffError("invalid_usage_shape")` to `"transient"` | "a suite that does not fit at the streamable ceiling is NOT retried at the phase level" — and, critically, a **dispatch-count** assertion: if the count stays green under this mutation, the test does not detect duplication and the 9-retries-reported-as-3 defect ships |
| 6 | `structural`, the freeze wedge | Same mutation as 5, applied to a run whose `FROZEN.json` exists and fails integrity | "a corrupt freeze is refused once, not retried" |
| 7 | `interrupted` | Make `reconcileOnBoot`'s first loop write `awaiting_input` even with the flag on | "a run interrupted by a restart is requeued automatically" |
| 8 | `interrupted`, the brake | Set `AUTO_CONTINUE_MAX` to `Infinity` | "a run at the cap is parked `awaiting_input` and not requeued" — this is the crash-loop test |
| 9 | Bound, both directions | Set `AUTO_CONTINUE_MAX` to `0` | The happy-path continuation test |
| 10 | Budget collision | Revert `RateLimitResumeInput.autoContinueCount` to `resumeCount` | "a run the owner resumed 3 times by hand still arms an automatic resume" |
| 11 | The wait ceiling | Delete the `RECOVERY_MAX_AUTO_WAIT_MS` arm from `planRateLimitResume` | "a `seven_day` window 5 days out is refused with a reason, not armed" (drive it with the real measured value, 431 997 s) |
| 12 | Attempt accounting | Revert `:4706` from accumulation to assignment | "a run continued after 2 fix rounds reports 5, not 2" — Area 1's check applies: if nothing moves, there is no test |
| 13 | Cancel disarm | Remove `#clearRateLimitTimer(runId)` from `cancel()` | "an armed timer does not fire on a cancelled run". Both directions already demonstrated by probe and inverse control |
| 14 | Honesty | Make `#writeVerdict` skip the attempts section when `attempts.length > 1` | "a run that took 3 attempts says so in verdict.md" |
| 15 | Empty history | Make the wire report `attempt: 1` when `run_attempts` has no rows | "a run predating the feature reports NO attempt history, not one clean attempt" |
| 16 | The status list (only if §8.4 is ever built) | Add a member to `ApiRunStatus`, leave `IN_FLIGHT` untouched | `cron-policy.test.ts:103` must go red. **It stays green today** — fixing that is a prerequisite, not a follow-up |

---

## 15. Files

Build command (never `npm test` / `npm start` — they write `dist/` and would corrupt the running
server on 4176):

```
cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-<LANE> && node --test "dist-<LANE>/**/*.test.js"
```

New:
- `/Users/kamilborzecki/Projects/coding-agent/dashboard/server/src/recovery-policy.ts`
- `/Users/kamilborzecki/Projects/coding-agent/dashboard/server/src/recovery-policy.test.ts`
- `/Users/kamilborzecki/Projects/coding-agent/dashboard/server/src/recovery-orchestrator.test.ts` (the injected-failure harness of §12.6)

Modified:
- `dashboard/server/src/orchestrator.ts` — `:663`, `:670-682`, `:717-780` (policy inputs); `:1366-1379`
  (cancel); `:1567-1579` (boot requeue); `:1696` + the six close sites (attempt rows); `:1801-1820`
  (spec throttle arm); `:4669`/`:4706` (gate budget and accounting); `:5470-5476`, `:5557-5599`
  (recovery metadata); `:5752-5771` (verdict section)
- `dashboard/server/src/db.ts` — `:350` (export `RUN_STATUSES`), `:447` (`SCHEMA`), `:588`
  (`RUN_COLUMNS`), `:644` (`ADDED_RUN_COLUMNS`), `~:1503-1529` (reader), `:982` (setter),
  `run_attempts` accessors
- `dashboard/server/src/subscription-caller.ts` — `:2057-2076`, `:2119-2133`
- `dashboard/server/src/claude-common.ts` — persist `utilization` (§12.3)
- `dashboard/server/src/api-types.ts` — `:268-271` neighbourhood, `RunDetail`
- `dashboard/server/src/http.ts` — `:626` (`toDetail`)
- `dashboard/server/src/cron/cron-policy.test.ts` — `:103-117` (derive the status list)
- `dashboard/server/src/rate-limit-resume.test.ts` — extend, do not duplicate
- `bakeoff/src/anthropic-seat.ts` — `:83-98`
- `dashboard/src/lib/api-types.ts` — the mirror only

**Do not touch:** `bakeoff/src/spec-agent.ts:1164-1211` (the ladder is correct and proven);
`dashboard/src/components/**`, `dashboard/src/app/**`, `dashboard/tests/**`,
`dashboard/server/src/graph.test.ts` (another workflow owns these).
