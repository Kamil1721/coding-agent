/**
 * The FROZEN dashboard HTTP API contract, transcribed exactly.
 *
 * This file is the UI's only statement about the wire format. It is owned by
 * the contract, not by this module: do not widen, narrow or "improve" a shape
 * here to make a component easier to write. Nullable fields are `T | null`,
 * never optional `T?`, matching the harness house style.
 *
 *   POST   /api/runs            {ticketText, modelId, deploy?, designLock?,
 *                                references?, captureUrl?} -> {runId}
 *   GET    /api/runs            -> RunSummary[]   (newest first)
 *   GET    /api/runs/:id        -> RunDetail
 *   GET    /api/runs/:id/events -> text/event-stream
 *   GET    /api/runs/:id/graph  -> RunGraphResponse   (additive; spec §9.2)
 *   GET    /api/runs/:id/files  -> CodeTreeResponse | CodeFileResponse (additive)
 *   POST   /api/runs/:id/cancel -> {ok:true}
 *   POST   /api/runs/:id/resume -> {ok:true}
 *   GET    /api/models          -> ModelOption[]
 *   GET    /api/health          -> {ok, claudeAuth, codexAuth, gate}
 */

/**
 * Mirrors the server's `ApiProvider`, which lost `"moonshot" | "deepseek"` on
 * 2026-07-30 with the Kimi and DeepSeek rows the owner removed. `"openai"` stays
 * because a run recorded before the 2026-07-28 Codex scope decision could carry
 * it; no row `/api/models` serves is anything but `"anthropic"`.
 */
export type Provider = "anthropic" | "openai";

/**
 * `included` = covered by a subscription, so NO dollar figure exists.
 *
 * `metered` survives with no producer: `cost.ts` reads this field to tell "a
 * subscription run has no cost" from "a metered run whose cost is not computed
 * yet", and that distinction still has to be drawable for a run whose model has
 * since left the catalog.
 */
export type ModelTier = "included" | "metered";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly provider: Provider;
  readonly tier: ModelTier;
  /** false => render disabled, with `reason` shown. */
  readonly available: boolean;
  readonly reason: string | null;
}

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "rate_limited"
  | "passed"
  | "failed"
  | "cancelled";

export interface RunSummary {
  readonly runId: string;
  readonly ticketTitle: string;
  readonly modelId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** null = not scored yet. NOT the same as false. */
  readonly heldOutPass: boolean | null;
  /** null = not scored yet. NOT the same as false. */
  readonly falseFinish: boolean | null;
}

export type RunPhase = "spec" | "build" | "gate" | "judge" | "done";

/**
 * Gating tier, from `bakeoff/src/contracts.ts` and research doc 02 section 5.4.
 * QUALITY is REPORTED, NEVER GATING — a failing QUALITY criterion must never be
 * rendered the way a failing BLOCKING criterion is.
 */
export type CriterionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";

export type CriterionResult = "pass" | "fail" | "pending";

export interface RunCriterion {
  readonly id: string;
  readonly statement: string;
  readonly tier: CriterionTier;
  readonly result: CriterionResult;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/* -------------------------------------------------------------------------
 * SPEND, ATTRIBUTED BY SEAT
 *
 * `RunDetail.tokens` IS THE BUILDER'S ROW, NOT THE RUN'S SPEND. Measured on one
 * live run: the builder reported 88,529 output tokens while the spec, audit and
 * judge seats spent 416,111, 17,603 and 3,228 — so the figure this UI renders
 * beside a run is 16.8% of what that run actually spent. These shapes are the
 * whole of it, one row per seat and ONE TOTAL PER VENDOR.
 *
 * TRANSCRIBED FROM `ApiSeatSpend`, `ApiVendorSpend`, `ApiMeteredSpend` and
 * `ApiRunSpend` in `dashboard/server/src/api-types.ts`, which carry the full
 * reasoning. Nothing but `contract-parity.test.ts` compares the two files —
 * forgetting a field here compiles clean on both sides and simply never renders.
 * ---------------------------------------------------------------------- */

/**
 * Which SEAT spent it. NOT the bake-off's `SeatRole`.
 *
 * `audit` and `judge` are ONE seat constant doing two jobs — the adversarial
 * bad-test pass before the build, and the code-reading pass after the gate — and
 * they are separate members here because collapsing them puts 17,603 + 3,228
 * under a name that belongs to neither. There is no `design` member: the design
 * segment spends on the BUILDER's session, and the design lane's own spend is
 * metered image/video below.
 */
export type SpendSeat = "spec" | "audit" | "builder" | "fix" | "judge";

/**
 * Why a run has no dollar figure, as a value rather than an absence.
 *
 * DO NOT RENDER THIS AS AN EM DASH OR AS `$0.00`. `costUsd: null` already reads
 * as "missing data" and `run.json`'s `totalCostUsd: 0` already reads as "free";
 * this field is the statement that neither is true. `describeCost` in
 * `src/lib/cost.ts` is the only sanctioned way to turn cost into pixels and its
 * `included` branch says the same thing in prose.
 */
export type PricingBasis = "not-priced-subscription-seat";

/** One seat's token spend. Never a dollar figure. */
export interface SeatSpend {
  readonly seat: SpendSeat;
  readonly provider: Provider;
  /** The model the seat was CONFIGURED with — not a claim that one model ran. */
  readonly modelId: string;
  readonly tokens: TokenCounts;
  readonly callCount: number;
}

/**
 * One VENDOR's total. There is no single scalar, and there must not be: token
 * counts are never summed across vendors, because tokenizers differ. On a Codex
 * run this list has two rows and "the run's tokens" is two numbers.
 */
export interface VendorSpend {
  readonly provider: Provider;
  readonly tokens: TokenCounts;
  readonly callCount: number;
  /** The seats folded into this row, in the order the run acquired them. */
  readonly seats: readonly SpendSeat[];
}

/**
 * Spend billed by the call or by the second against a metered key.
 *
 * NO `provider`: the design lane's image and video calls go to a vendor that is
 * not one of the four the dashboard can build with. `deliveredSecondsFloor` is a
 * FLOOR on what was billed — video that was generated, billed and then failed
 * its download counts as zero — and it is `null`, never `0`, for a call that is
 * not billed by time at all.
 */
export interface MeteredSpend {
  readonly kind: "image" | "video";
  readonly model: string;
  /** Calls ATTEMPTED, retries included. A count, never money. */
  readonly calls: number;
  readonly deliveredSecondsFloor: number | null;
}

/**
 * Everything one run spent.
 *
 * AN EMPTY `bySeat` MEANS NOTHING WAS RECORDED, never "this run spent nothing".
 * Render it as the absence it is; a row of zeros for a run that burned four
 * hundred thousand tokens before the recorder ran is worse than no row.
 */
export interface RunSpend {
  readonly bySeat: readonly SeatSpend[];
  readonly byVendor: readonly VendorSpend[];
  readonly metered: readonly MeteredSpend[];
  readonly pricing: PricingBasis;
}

export interface RateLimitState {
  readonly limited: boolean;
  readonly retryAfterSec: number | null;
}

/**
 * HOW LONG A RUN HAS BEEN QUIET. NOT A DIAGNOSIS — mirrors `ApiRunSilence`.
 *
 * WHY IT EXISTS: a run on this machine sat `running` for eight and a half hours
 * with an idle subprocess and a 506-minute gap between two rows of its own event
 * stream, and no screen anywhere said so.
 *
 * WHAT IT IS NOT. There is no `dead`, no `hung` and no `stalled` here, because
 * the server cannot establish any of them: a model that is thinking, a process
 * blocked on a socket and a crashed subprocess all look exactly like this. The
 * research this project is built on (doc 03 §7.8) records that 79% of unresolved
 * long-horizon runs time out while STILL ACTIVELY MAKING PROGRESS, and warns
 * against acting on stuck-detection heuristics. Render it as an observation the
 * owner can act on — "nothing heard for 94 min" — and never as a verdict.
 *
 * `RunDetail.silence === null` MEANS NOT WATCHED, NOT HEALTHY. Only a `running`
 * run is measured; `queued`, `awaiting_input`, `rate_limited` and every terminal
 * status report `null`, and the parks are quiet on purpose.
 */
export interface RunSilence {
  /** The instant the silence is measured from. See `sinceKind` for which instant. */
  readonly since: string;
  /**
   * `last-event` — `since` is the newest event on the run's stream.
   * `run-start` — the run has emitted nothing at all, so `since` is its start.
   * Do not collapse them: the second is a run that has never spoken.
   */
  readonly sinceKind: "last-event" | "run-start";
  /**
   * Whole minutes, floored, AT RESPONSE TIME. A snapshot, not a ticking value —
   * derive a live counter from `since`, which stays true between polls.
   */
  readonly quietMin: number;
  /** The server's threshold in minutes (`DASHBOARD_SILENCE_WARN_MIN`, default 90). */
  readonly thresholdMin: number;
  /** `quietMin >= thresholdMin`. "Longer than expected", not "stuck". */
  readonly overThreshold: boolean;
}

export interface Screenshot {
  readonly path: string;
  readonly label: string;
  readonly capturedAt: string;
}

/**
 * The DESIGN lane's lock — the server's `ApiDesignLock`, mirrored by hand.
 *
 * NOTHING BUT `contract-parity.test.ts` COMPARES THIS WITH THE SERVER. The two
 * packages are separate TypeScript programs, so a field that exists on the
 * server and not here compiles clean on both sides, is serialised, arrives, and
 * never renders. That test reads this file as text and asserts every field
 * below by name; if you change one, change it there in the same commit.
 *
 * `mockups[].path` is an ABSOLUTE HOST PATH, like `screenshots[].path` — a
 * browser cannot open it. `src/lib/screenshots.ts` turns it into a URL on
 * `GET /api/runs/:id/screenshots/:file`, which is the route these images are
 * served by (spec §17.1: no new image route exists for this).
 */
export interface DesignLockState {
  /** The run is parked RIGHT NOW waiting for a mockup to be chosen. */
  readonly awaiting: boolean;
  readonly mockups: readonly Screenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
}

/**
 * ONE human-factors finding — the server's `ApiAdversaryFinding`, mirrored by
 * hand. Nothing but `contract-parity.test.ts` and `adversary.test.ts` compare
 * the two files.
 *
 * `severity` IS A CLOSED UNION and may be relied on for ordering and colour: the
 * server's parser drops any entry whose severity is not one of these four, so a
 * fifth value cannot arrive. `klass` is NOT closed — it is the server's
 * `FailureClass` vocabulary (install, build, boot, route, visual, test-infra,
 * logic, structure), typed `string` on both sides so every renderer keeps a
 * default branch.
 *
 * `detail` IS `""` WHEN THE PASS GAVE NO REPRO, never absent. Empty is a
 * statement — "it reported a finding and no evidence text" — and should render
 * as the absence it is rather than as a blank line.
 */
export interface AdversaryFinding {
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly klass: string;
  readonly summary: string;
  readonly detail: string;
}

/**
 * The human-factors adversary pass — the server's `ApiAdversaryPass`, mirrored
 * by hand.
 *
 * THIS LANE HAS NEVER EXECUTED. Said in those words because it is the first
 * thing anyone building a panel on it needs to know: the pass needs a running
 * preview URL, which needs a scored run, and no run has reached it. The read
 * path, the mapper and this mirror are tested; THE PRODUCER HAS NEVER RUN. Do
 * not write copy that implies these findings are a proven channel, and do not
 * treat `null` as an error state — it is what every run reports today.
 *
 * THE TRUTH TABLE. `RunDetail.adversary === null` means no record at all: the
 * run never reached the pass. Inside a record:
 *
 *   `ran: false`, `findings: null`   considered and DECLINED — `stop` says why
 *                                    (`not-applicable` when the run has no
 *                                    loopback preview; the rest are refusals).
 *   `ran: true`,  `findings: null`   it ran and LEFT NO REPORT. NOT "found
 *                                    nothing" — the report is a file the
 *                                    session writes, and a missing file means
 *                                    the server cannot see what it found.
 *   `ran: true`,  `findings: []`     it ran, reported, and FOUND NOTHING.
 *
 * The last two must never render as the same sentence. "No usability problems
 * found" for a pass that filed no report is a claim nothing measured.
 *
 * NON-GATING. These findings cannot move `heldOutPass`, `status` or
 * `failureReason` — the server folds them into the backlog only. Render them as
 * judgement, never as failures, and never beside a criterion result.
 */
export interface AdversaryPass {
  /** The session was actually spawned. False for every refusal. */
  readonly ran: boolean;
  /**
   * Why it stopped, or `ran` when it completed. The server's vocabulary is
   * `ran`, `not-applicable`, `agent-missing`, `agent-denylist-drift`,
   * `denylist-incomplete`, `workspace-not-isolated`, `timeout`, `failed`,
   * `cancelled` — typed `string` on both sides deliberately, so ANY renderer
   * needs a default branch. A stop this build has never heard of is a newer
   * server, not a bug.
   */
  readonly stop: string;
  /**
   * The lane's sentence about why it stopped — EMPTY on a clean run. NOT a
   * finding's repro text; that is `AdversaryFinding.detail`, and the two keys
   * are spelled differently so a nested render cannot swap them.
   *
   * THE SERVER TRUNCATES IT AT 2000 CHARACTERS — a `failed` stop carries an
   * unbounded error message — so this can arrive cut off mid-sentence. Do not
   * present it as the complete cause; the full text is only in the run's own
   * record file and log stream.
   */
  readonly stopDetail: string;
  /** `null` = no report to read; `[]` = a report that found nothing. */
  readonly findings: readonly AdversaryFinding[] | null;
}

/**
 * Something in the workspace that was NOT copied into the published project —
 * the server's `ApiProjectExclusion`, mirrored by hand.
 *
 * RENDER IT, DO NOT HIDE IT. A folder that quietly drops `visible-acceptance/`
 * looks exactly like a copy that failed halfway. `path` is relative to the
 * workspace root, which is the same spelling the file viewer's `?path=` takes.
 */
export interface ProjectExclusion {
  readonly path: string;
  readonly reason: string;
}

/**
 * Where the run's finished code was COPIED so the owner can find it — the
 * server's `ApiPublishedProject`, mirrored by hand.
 *
 * THE POINT OF IT. The artefact lives at
 * `dashboard/runs/<44-character run id>/workspace/`, which the owner said he
 * cannot find and which does not read as his project. On a terminal run the
 * server copies it to `projects/<slug-of-the-ticket-title>/`.
 *
 * IT IS A HOST PATH, NOT A LINK. A browser cannot open it — the same as
 * `artifactPath`, `verdictPath` and `screenshots[].path`. And it is NOT
 * `previewUrl`: that is a dead address on every run this machine has recorded
 * (the process that served it exited with the run), so do not turn this into an
 * anchor and do not put the two behind one button.
 *
 * THREE STATES. `null` = nothing recorded (not terminal yet, or older than this
 * lane); `published: false` = ATTEMPTED AND DECLINED, with `reason` and
 * `detail`; `published: true` = the copy exists. Rendering the first two the
 * same way ("no folder") throws away the only sentence that says why.
 *
 * IT IS NOT A QUALITY SIGNAL. A FAILED run publishes too — a failed build's code
 * is still the thing the owner asked to be able to open — so never place this
 * next to a green badge as though it meant the run succeeded. `heldOutPass` is
 * the field that says that.
 */
export type PublishedProject =
  | {
      readonly published: true;
      /** Absolute host path of the copy. */
      readonly path: string;
      readonly publishedAt: string;
      /** Regular files copied; directories are not counted. */
      readonly fileCount: number;
      readonly bytes: number;
      /** What was left behind, and why. Empty means nothing was filtered. */
      readonly excluded: readonly ProjectExclusion[];
    }
  | {
      readonly published: false;
      /**
       * Which refusal. The server's vocabulary is `workspace-missing`,
       * `workspace-empty`, `no-free-name`, `copy-failed` — typed `string` on both
       * sides deliberately, so every renderer keeps a default branch.
       */
      readonly reason: string;
      readonly detail: string;
      readonly attemptedAt: string;
    };

export interface RunDetail extends RunSummary {
  readonly ticketText: string;
  readonly phase: RunPhase;
  readonly criteria: readonly RunCriterion[];
  readonly tokens: TokenCounts | null;
  /**
   * ALWAYS null for subscription runs — quota is consumed, not billed.
   * Never invent one. See `describeCost` in `src/lib/cost.ts` for the only
   * sanctioned way to turn this into pixels.
   */
  readonly costUsd: number | null;
  readonly rateLimit: RateLimitState | null;
  /**
   * How long this run has been quiet, or `null` when it is not being watched.
   *
   * The server derives it per request from the run's own event rows, so it is
   * correct the instant a restarted dashboard answers — there is no timer to
   * miss and no column to go stale. See `RunSilence` before rendering: `null` is
   * "not watched", and `overThreshold` is "nothing heard for N minutes", not a
   * claim that the run has died.
   */
  readonly silence: RunSilence | null;
  readonly screenshots: readonly Screenshot[];
  readonly artifactPath: string | null;
  readonly previewUrl: string | null;
  /**
   * Where the finished code was copied so the owner can find it, or `null` when
   * no publish has been recorded for this run.
   *
   * See `PublishedProject`: three states, and `null` ("never attempted") is not
   * `published: false` ("attempted and declined"). Written when the run goes
   * terminal, so a live run legitimately reports `null`.
   */
  readonly publishedProject: PublishedProject | null;
  /**
   * Criteria the run was graded against that the OWNER DID NOT STATE — the
   * grader's guesses plus the house defaults. A pass against criteria nobody
   * wrote is the dangerous case, so this is the number to render beside a green
   * badge, not to hide behind one.
   *
   * 0 until the spec phase exits, and 0 then means zero, not "unknown".
   */
  readonly inferredCriteria: number;
  /**
   * Absolute HOST path to the run's `verdict.md`. Like `screenshots[].path` and
   * `artifactPath`, a browser cannot open it directly.
   *
   * EMPTY UNTIL THE RUN IS TERMINAL. `rate_limited` and `awaiting_input` are
   * stopped, not finished, so they carry no verdict; "" is "not written yet" and
   * never "written but missing".
   */
  readonly verdictPath: string;
  /**
   * Gate runs the GATE/FIX loop actually performed. 1 means "gated once".
   *
   * 0 IS "NO LOOP OUTCOME YET", NEVER "passed first time" — that is 1. Queued,
   * building, rate-limited and cancelled-before-the-gate all read 0. Do not
   * render it as a pass count.
   */
  readonly gateAttempts: number;
  /**
   * Why the loop stopped, or `null` when it has not stopped.
   *
   * `null` IS NOT `"green"` — it means nothing has been recorded, and it moves
   * with `gateAttempts: 0`. The server's vocabulary is `green`, `retry-cap`,
   * `not-converging`, `infra`, `cancelled`; it is typed `string` on both sides
   * deliberately, so ANY renderer needs a default branch. A reason this build
   * has never heard of is a newer server, not a bug.
   */
  readonly gateStopReason: string | null;
  /**
   * The last thing that went wrong, in the words the server recorded it in.
   *
   * A NON-NULL VALUE IS NOT A FAILED RUN. `awaiting_input` and `rate_limited`
   * are stopped, not finished: a run parked for a mockup choice carries
   * `DESIGN LANE FAILED (too-few-images)` while it is still live and still
   * resumable. Gate this on `status` before you render it, and never let it
   * become a second, contradicting status badge.
   *
   * IT IS THE LAST WRITE, NOT THE FIRST OR THE WORST. One column, five writers
   * on the server; a run whose design lane failed and which then reached the gate
   * reports the gate's answer and nothing about the lane. So "why this run
   * failed" is the honest framing only when the status already says it failed,
   * and even then it is the last recorded cause rather than a history.
   *
   * `null` on a passed run is written deliberately, not left over — the server
   * clears it when the held-out suite goes green.
   */
  readonly failureReason: string | null;
  /**
   * The DESIGN lane's lock, or `null` when this run has no DESIGN lane.
   *
   * THE NULL IS LOAD-BEARING AND IS NOT THE SAME AS AN EMPTY LOCK. `null` means
   * "no DESIGN lane on this run"; `{awaiting: false, locked: null}` means "the
   * lane ran and produced nothing to lock" — degraded, or failed. Render
   * different things for them; a run whose lane silently produced no mockups is
   * the case the whole lane's reporting exists to make visible.
   */
  readonly designLock: DesignLockState | null;
  /**
   * The human-factors adversary pass, or `null` when the run left no record.
   *
   * `null` IS THE ORDINARY CASE TODAY — the lane has never executed, so every
   * run reports it. Two different nulls live here and {@link AdversaryPass}
   * spells out both: this one is "no pass record on this run", the one on
   * `findings` inside it is "the pass filed no report", and neither of them is
   * "the pass found nothing" (that is `findings: []`).
   *
   * The server reads it from the run's own `results/adversary.json` and puts
   * only these four values on the wire; `results/` is not browsable and must not
   * become browsable, because it holds held-out test titles.
   */
  readonly adversary: AdversaryPass | null;
}

/**
 * Can the sealed gate be built on the server's machine? — the server's
 * `GateHealth`, mirrored by hand.
 *
 * ONLY `"ok"` MAY RENDER AS A PASS. `"unknown"` means no probe has completed
 * yet — the answer is absent, not fine — and it gets its own neutral state, the
 * same refusal `heldOutPass: null` makes against being drawn as `false`. A
 * three-state field rendered as a boolean is how a gate nobody checked becomes a
 * green tick.
 *
 * WHAT `ok` BUYS: the server built the gate with the same call and the same
 * environment the run's gate phase uses, and docker resolved the scorer image's
 * digest. It does NOT mean a scoring container has run, and it is not a promise
 * about the future — the gate phase happens ~1h45 later on a real run, which is
 * the whole reason this is worth showing before the ticket is submitted.
 *
 * `detail` MAY BE MULTI-LINE: on `unavailable` it is the server's error text
 * plus a `fix:` line carrying the exact `docker build …` command. Preserve the
 * newlines (`whitespace-pre-line`) or the command runs into the sentence.
 *
 * `checkedAt` is `null` exactly when `state` is `"unknown"`. The probe is cached
 * for at least a minute, so an `ok` describes that instant and not this one.
 *
 * READ IT DEFENSIVELY UNTIL THE FIXTURES CATCH UP. `dashboard/tests/fixtures/api-server.ts`
 * and the health stubs in `design-lock.browser.spec.ts` / `model-picker.browser.spec.ts`
 * still serve a health body with NO `gate` key, so `health.gate.state` WOULD
 * throw a TypeError under those specs even though this type says it cannot —
 * nothing reads the field yet, so that is a trap set for the first renderer and
 * not a live break. The type is right about the real server; the fixtures are
 * the thing that has to change.
 */
export interface GateHealth {
  readonly state: "ok" | "unavailable" | "unknown";
  readonly detail: string;
  readonly checkedAt: string | null;
}

export interface HealthState {
  /**
   * AUTH ONLY. The gate is NOT folded into this boolean: a run with docker down
   * still builds and still produces code, it just cannot be scored, and the
   * unattended cron tick refuses to submit anything when this is false —
   * naming authentication as the cause. Read `gate` for the gate.
   */
  readonly ok: boolean;
  readonly claudeAuth: "ok" | "missing";
  readonly codexAuth: "ok" | "missing";
  readonly gate: GateHealth;
}

export interface CreateRunRequest {
  readonly ticketText: string;
  readonly modelId: string;
  readonly deploy?: boolean;
  /**
   * Who picks the mockup: the owner (`"ask"`) or `ui-designer` (`"auto"`).
   *
   * OPTIONAL HERE, REQUIRED-BUT-NULLABLE ON THE SERVER, the same asymmetry
   * `deploy` already has: a caller omits what it has no opinion about, and the
   * wire carries the absence. `api.ts` fills in `"auto"` for every dashboard
   * submission — read the comment there before removing it.
   */
  readonly designLock?: "auto" | "ask" | null;
  /**
   * Reference images for the ticket, as base64 `data:image/…` URLs.
   *
   * The same shape and the same caps as the chat's image intake: at most 6, at
   * most 8 MB each decoded, png/jpeg/webp/gif. Build them the way the chat box
   * does — `FileReader.readAsDataURL` — and send them alongside the text.
   *
   * SENDING ONE CHANGES WHICH TICKET THIS IS. The server folds each image's
   * sha256 into the ticket id, so the same words with a different image address
   * a DIFFERENT frozen acceptance suite, and re-submitting the same file mints a
   * new ticket rather than reusing the old one. That is the owner's explicit
   * decision, not an accident of the encoding: without it, two runs with
   * different visual briefs would share one sealed suite and the verdict could
   * not say which reference the build was graded against. A form that offers
   * "attach a reference" should not imply the run is otherwise unchanged.
   *
   * OPTIONAL HERE, REQUIRED-BUT-NULLABLE ON THE SERVER — the same asymmetry
   * `deploy` and `designLock` already have.
   */
  readonly references?: readonly string[];
  /**
   * Documents for the ticket — a scope, a brief, a CV — as base64 data URLs.
   *
   * Built the same way the images are (`FileReader.readAsDataURL`), sent in the
   * same POST. At most 4, at most 12 MB each decoded; the server accepts PDF,
   * plain text, markdown, CSV, JSON, .docx, .doc and both spellings of RTF, and
   * refuses anything else as `invalid_document` with a sentence naming the type
   * it was given. A whole body over the route's envelope is `body_too_large`,
   * which is a different failure from a single file being too big.
   *
   * SENDING ONE CHANGES WHICH TICKET THIS IS, exactly as a reference image does:
   * the server folds each document's sha256 into the ticket id, so an amended
   * scope with unchanged words addresses a DIFFERENT frozen acceptance suite and
   * pays to have it authored. A form that offers "attach a scope" should not
   * imply the run is otherwise unchanged.
   *
   * AND SENDING ONE IS NOT THE SAME AS THE RUN READING IT. The intake stores the
   * bytes, records their paths and digests, and emits a `warn` on the run's
   * event stream saying so; whether a seat is given the document is decided by
   * the server's build and spec wiring, not by this field. Do not render
   * "attached" as "the run has read your scope" — the run's own log is where the
   * truth for a given run is.
   *
   * OPTIONAL HERE, REQUIRED-BUT-NULLABLE ON THE SERVER — the same asymmetry
   * `deploy`, `designLock` and `references` already have.
   */
  readonly documents?: readonly string[];
  /**
   * Which page the server should capture before authoring the suite.
   *
   * ABSENT means "scan my ticket text and capture the first http(s) URL you
   * find" — the behaviour "make a copy of kamilborzecki.dev" needs. `null` is
   * the opt-out for a ticket that merely cites a URL. A string names one
   * explicitly.
   *
   * WHY A FORM WOULD OFFER THE OPT-OUT: the capture is SLOW and it moves the
   * ticket id. A healthy page costs a few seconds, but the server's own bounds
   * add up to roughly a minute in the worst case (browser launch, navigation,
   * one full-page screenshot per width) and the POST returns nothing until it
   * finishes — so a submit button wired to this needs a pending state, not a
   * spinner-free wait. Its extracted outline also becomes part of the ticket
   * text, so it changes which frozen suite the run is graded against. A brief
   * that merely links to documentation wants neither.
   *
   * A FAILED CAPTURE STILL CREATES THE RUN. The reason arrives as a `warn` on
   * the run's event stream; there is no field on the response for it, and there
   * is no field on `RunDetail` for the references either — what the owner sees
   * of the capture is the outline, which is part of `RunDetail.ticketText`.
   */
  readonly captureUrl?: string | null;
}

export interface CreateRunResponse {
  readonly runId: string;
}

/**
 * `POST /api/runs/:id/messages` — the body the chat box sends.
 *
 * MIRRORS THE SERVER'S `SendMessageRequest`, and is written down here for the
 * same reason that one is: the route now takes two kinds of attachment, and a
 * body built inline in one `fetch` with no declared shape is how a client comes
 * to send `document` where the server reads `documents` and nobody finds out
 * until an owner's scope silently does nothing.
 *
 * NOT YET IMPORTED BY `api.ts`. `sendRunMessage` there takes `(runId, text,
 * images)` and constructs `{text, images}` by hand; wiring a document picker
 * into the chat box means widening that function and typing its body with this.
 * The server accepts `documents` today either way.
 *
 * A MESSAGE NEEDS TEXT, AN IMAGE, OR A DOCUMENT. All three absent is refused as
 * `empty_message`.
 *
 * WHAT THE SERVER DOES WITH `documents`: stores them under `runs/<id>/chat/`,
 * returns their paths on the response's additive `documents` field, and emits a
 * `warn` on the run's event stream saying they were STORED, NOT DELIVERED — the
 * chat channel to a running agent carries text and image paths only, and no
 * document reaches the run through it. They are also NOT part of the ticket's
 * identity, unlike `CreateRunRequest.documents`: this run's ticket id was fixed
 * when it was created. A chat box that shows a document as "sent" without
 * surfacing that warning is claiming something the server did not do.
 */
export interface SendMessageRequest {
  readonly text?: string;
  readonly images?: readonly string[];
  readonly documents?: readonly string[];
}

export interface OkResponse {
  readonly ok: true;
}

/* ------------------------------------------------------------------ */
/* The orchestration canvas — spec §9.1                                */
/*                                                                     */
/* THE SEVEN `graph_*` MEMBERS RIDE THE EXISTING SSE UNION. There is no */
/* second channel and there must never be one: total ordering against  */
/* `status`/`phase` is a CORRECTNESS requirement — an agent must not    */
/* show "running" inside a cancelled run — and the stream's `seq` gives */
/* it for free, along with resumability that already works.            */
/* ------------------------------------------------------------------ */

/**
 * Did the emitter KNOW which node this belongs to, or work it out?
 *
 * REQUIRED, NEVER OPTIONAL. Hook messages carry no task identity, so hook→agent
 * attribution is a server-side inference; the required field is what forces
 * every emitter to say so, and what lets the canvas draw an inferred edge
 * differently instead of lying. It marks a GUESSED edge — a WRONG node is never
 * sent at all, it is dropped on the server.
 */
export type GraphAttribution = "exact" | "inferred";

/** Delivery lane. Declared once, by the node itself, on `graph_agent`. */
export type RunLane = "spec" | "design" | "build" | "review" | "gate";

/** An agent's state IN THE CLI'S OWN WORDS. See `GraphNodeState` for the rest. */
export type GraphAgentState = "running" | "completed" | "failed" | "stopped";

/**
 * Raw SDK identifiers, FOR THE INSPECTOR ONLY — never identity.
 *
 * The server's redactor rewrites any 40+ character mixed-case-and-digit token to
 * one identical literal, and `task_id` has no documented length bound, so two
 * distinct agents can arrive carrying the same string. Node identity is the
 * short server-assigned `id`; nothing here is ever keyed on, on either side.
 */
export interface GraphSdkRef {
  readonly taskId: string;
  readonly toolUseId: string | null;
}

export interface GraphMcpServer {
  readonly name: string;
  readonly status: string;
}

/**
 * A node's state, including the one no emitter may claim.
 *
 * `unresolved` = the run ended while this agent still read `running`, and the
 * stream never said how it finished. NOT `failed`: a cancelled run's in-flight
 * agents did not fail, and `heldOutPass: null` is not `false` for the same
 * reason. Render it as "we stopped watching", never as an error.
 */
export type GraphNodeState = GraphAgentState | "unresolved";

/** Distinct names with a call count — NOT one pill per call. */
export interface GraphToolPill {
  readonly name: string;
  readonly mcpServer: string | null;
  readonly count: number;
}

export interface GraphSkillPill {
  readonly skill: string;
  readonly source: "preloaded" | "invoked";
  readonly count: number;
}

export interface GraphHookPill {
  readonly event: string;
  readonly tool: string;
  readonly decision: "allow" | "deny";
  readonly count: number;
}

export interface GraphResult {
  readonly state: GraphAgentState;
  readonly summary: string;
  readonly totalTokens: number | null;
  readonly toolUses: number | null;
  readonly durationMs: number | null;
}

/**
 * One thing an agent did, in the order it did it. Mirrors the server's
 * `GraphActivityEntry`; the two are checked against each other at the `foldGraph`
 * call site in `use-run-graph.ts`, which is the only place they meet.
 *
 * `at` is the SERVER's recorded instant, or null for a row written before the wire
 * carried one. Null renders as "time not recorded" and is never filled in with the
 * browser's clock — on a replayed run that would date every step of a two-hour run
 * to the moment the page opened.
 */
export interface GraphActivityEntry {
  readonly at: string | null;
  readonly kind: "tool" | "skill";
  readonly name: string;
  readonly detail: string;
  readonly truncated: boolean;
}

export interface GraphNode {
  readonly id: string;
  readonly parent: string | null;
  readonly agent: string | null;
  readonly lane: RunLane | null;
  readonly description: string;
  readonly ambient: boolean;
  readonly state: GraphNodeState;
  readonly attribution: GraphAttribution;
  readonly sdk: GraphSdkRef | null;
  readonly tools: readonly GraphToolPill[];
  readonly skills: readonly GraphSkillPill[];
  readonly hooks: readonly GraphHookPill[];
  /** Every tool call, including ones whose name did not fit in `tools`. */
  readonly toolCalls: number;
  readonly result: GraphResult | null;
  /** What this agent did, oldest first. The chronology `tools` cannot hold. */
  readonly activity: readonly GraphActivityEntry[];
  /** Entries past the cap: non-zero means `activity` is a prefix, not the whole. */
  readonly activityDropped: number;
}

/** `attribution` is the CHILD's: an edge to a guessed parent renders differently. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly attribution: GraphAttribution;
}

export interface GraphInventory {
  readonly agents: number;
  readonly skills: number;
  readonly tools: number;
  readonly allowedAgents: readonly string[];
  readonly mcpServers: readonly GraphMcpServer[];
  readonly plugins: readonly string[];
  readonly model: string;
  readonly claudeCodeVersion: string;
  readonly environmentHash: string;
}

/**
 * The whole canvas as a value.
 *
 * `inventory: null` means NOTHING WAS RECORDED — never "the CLI reported
 * nothing". An old run folds to exactly this, which is why the canvas needs no
 * feature flag.
 */
export interface GraphState {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly inventory: GraphInventory | null;
}

/**
 * `GET /api/runs/:id/graph` — snapshot, then subscribe.
 *
 * A WIRE-SIZE FIX, NOT A CPU ONE: a 32,000-row run is 7.01 MB of events but only
 * 22.7 ms to read. Fold this once, then open
 * `EventSource(/api/runs/:id/events?lastEventId=atSeq)`.
 *
 * `atSeq` IS A DURABLE WATERMARK — the seq of the last PERSISTED row that went
 * into the fold. The server replays from the same table, which is the only
 * reason the window between this response and the EventSource is not a race.
 */
export interface RunGraphResponse extends GraphState {
  readonly atSeq: number;
}

/* ------------------------------------------------------------------ */
/* SSE event shapes on /api/runs/:id/events                            */
/* ------------------------------------------------------------------ */

export type LogLevel = "info" | "warn" | "error";

export type RunEvent =
  | { readonly type: "phase"; readonly phase: RunPhase; readonly at?: string }
  /**
   * `at` IS THE SERVER'S INSTANT, NOT THE CLIENT'S RECEIPT TIME.
   *
   * Optional because a run recorded before the wire carried `at` has none. The
   * distinction is load-bearing and has been got wrong twice in this codebase:
   * stamping receipt time looks perfect while you watch a run and is silently
   * wrong on REPLAY, where a page refresh re-delivers an hour of history in one
   * burst and every row claims to have just happened.
   */
  | {
      readonly type: "log";
      readonly level: LogLevel;
      readonly text: string;
      readonly at?: string;
    }
  | { readonly type: "tool"; readonly name: string; readonly summary: string; readonly at?: string }
  | {
      readonly type: "criterion";
      readonly id: string;
      readonly result: CriterionResult;
    }
  | { readonly type: "screenshot"; readonly path: string; readonly label: string }
  | ({ readonly type: "tokens" } & TokenCounts)
  /**
   * Provider rate-limit state. `limited` SAYS WHETHER IT IS ACTUALLY A LIMIT.
   *
   * The SDK emits this routinely to report when the current window rolls over,
   * with nothing refused. Treating every one as a refusal is what printed
   * `rate limited; retry after 253699s` on a run whose subscription was fine.
   * `retryAfterSec` is 0 when the provider did not report a reset instant.
   */
  | {
      readonly type: "rate_limit";
      readonly limited: boolean;
      readonly retryAfterSec: number;
      readonly at?: string;
    }
  /**
   * The run wrote its verdict. Emitted once, immediately before the terminal
   * `status` event. A path and a count; never the verdict's text.
   */
  | {
      readonly type: "verdict";
      readonly verdictPath: string;
      readonly inferredCriteria: number;
    }
  | { readonly type: "status"; readonly status: RunStatus; readonly at?: string }
  /* ---- the orchestration canvas, spec §9.1 ---------------------------- */
  /**
   * A node exists. ALWAYS FIRST FOR ITS NODE — the invariant is that a node id
   * is never referenced before its `graph_agent`, which is why every event below
   * carries only `node` and none of them carries `lane`.
   *
   * `agent` is nullable because `subagent_type` is optional in the SDK's own
   * typing; the node is still real, its name simply was not reported.
   */
  | {
      readonly type: "graph_agent";
      readonly node: string;
      readonly parent: string | null;
      readonly agent: string | null;
      readonly lane: RunLane | null;
      readonly description: string;
      readonly ambient: boolean;
      readonly attribution: GraphAttribution;
      readonly sdk: GraphSdkRef | null;
    }
  | {
      readonly type: "graph_agent_status";
      readonly node: string;
      readonly state: GraphAgentState;
      readonly attribution: GraphAttribution;
    }
  /** An MCP call IS a tool call; `mcpServer` names the server, or is null. */
  | {
      readonly type: "graph_tool";
      readonly node: string;
      readonly name: string;
      readonly mcpServer: string | null;
      readonly summary: string;
      readonly attribution: GraphAttribution;
    }
  | {
      readonly type: "graph_skill";
      readonly node: string;
      readonly skill: string;
      readonly source: "preloaded" | "invoked";
      readonly attribution: GraphAttribution;
    }
  /** Always `attribution: "inferred"` — hook input carries no task identity. */
  | {
      readonly type: "graph_hook";
      readonly node: string;
      readonly event: string;
      readonly tool: string;
      readonly decision: "allow" | "deny";
      readonly reason: string;
      readonly attribution: GraphAttribution;
    }
  | {
      readonly type: "graph_result";
      readonly node: string;
      readonly state: GraphAgentState;
      readonly summary: string;
      /** Null when the CLI reported no usage. NOT 0, which is a claim. */
      readonly totalTokens: number | null;
      readonly toolUses: number | null;
      readonly durationMs: number | null;
      readonly attribution: GraphAttribution;
    }
  | {
      readonly type: "graph_inventory";
      readonly agents: number;
      readonly skills: number;
      readonly tools: number;
      /** The delegation shortlist. Visibility is not permission. */
      readonly allowedAgents: readonly string[];
      readonly mcpServers: readonly GraphMcpServer[];
      readonly plugins: readonly string[];
      readonly model: string;
      readonly claudeCodeVersion: string;
      readonly environmentHash: string;
    };

export type RunEventType = RunEvent["type"];

/* ------------------------------------------------------------------ */
/* Runtime narrowing                                                   */
/* ------------------------------------------------------------------ */

/**
 * These sets exist so that a value arriving over the wire that is NOT in the
 * frozen union is treated as unknown-but-harmless rather than silently typed
 * as a member of it. The UI renders a neutral badge for an unrecognised value;
 * it never throws at the user, and it never guesses a mapping.
 */
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "awaiting_input",
  "rate_limited",
  "passed",
  "failed",
  "cancelled",
]);

const RUN_PHASES: ReadonlySet<string> = new Set([
  "spec",
  "build",
  "gate",
  "judge",
  "done",
]);

const CRITERION_TIERS: ReadonlySet<string> = new Set([
  "BLOCKING",
  "FUNCTIONAL",
  "QUALITY",
]);

export function isRunStatus(value: string): value is RunStatus {
  return RUN_STATUSES.has(value);
}

export function isRunPhase(value: string): value is RunPhase {
  return RUN_PHASES.has(value);
}

export function isCriterionTier(value: string): value is CriterionTier {
  return CRITERION_TIERS.has(value);
}

/** A run that will not change again without an explicit resume. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === "passed" || status === "failed" || status === "cancelled";
}

/**
 * A run that is stopped but resumable. `rate_limited` is an EXPECTED state on
 * a subscription plan, not an error: the 5-hour rolling window has to drain.
 * `awaiting_input` is stalled on something the frozen API exposes no channel
 * for, so the only moves are resume and cancel.
 *
 * STOPPED DOES NOT MEAN "WILL RESTART ITSELF". The server can be started with an
 * opt-in auto-resume for `rate_limited` (off by default, and it refuses to arm
 * when the provider reported no reset instant), but NOTHING ON THIS WIRE SAYS
 * WHETHER IT DID — there is no armed flag and no deadline field, and
 * `RateLimitState.retryAfterSec` is the provider's reported window, not a
 * promise that anything is counting it down. So the UI must not print a
 * countdown-to-resume or claim the run will come back on its own; the truthful
 * rendering is "stopped, resumable", with Resume as the move the owner has.
 */
export function isStalledStatus(status: RunStatus): boolean {
  return status === "rate_limited" || status === "awaiting_input";
}

/* -------------------------------------------------------------------------
 * `GET /api/runs/:id/files` — the code the run produced
 *
 * Transcribed from `server/src/api-types.ts`. ONE route, two responses
 * discriminated by `kind`: no `?path` is the tree, `?path=<relative>` is one
 * file. Every refusal lives in `server/src/code-files.ts` and every one of them
 * arrives here as the standard `{error, message, remediation}` body, so the
 * viewer renders the server's sentence rather than inventing its own.
 * ---------------------------------------------------------------------- */

/**
 * One node of the run's workspace.
 *
 * `path` IS THE KEY AND THE REQUEST: relative to the workspace root, forward
 * slashes, no leading slash — the exact spelling `?path=` accepts. The client
 * therefore never constructs a path the server has not already listed.
 *
 * `bytes` is `null` for a directory and the FULL size on disk for a file, even a
 * truncated one, so the viewer can say "showing 256 KB of 12.4 MB".
 */
export interface CodeTreeEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "dir" | "file";
  readonly bytes: number | null;
}

/**
 * Something in the workspace that was not listed, and why.
 *
 * RENDERED, NOT DROPPED. A viewer that silently omits `.git` and every
 * credential file is indistinguishable from one that failed to read the
 * directory; the reader cannot tell an empty workspace from a filtered one.
 */
export interface CodeExclusion {
  readonly path: string;
  readonly reason: string;
}

export interface CodeTreeResponse {
  readonly kind: "tree";
  readonly runId: string;
  /** The absolute host path, for the reader who wants a terminal. */
  readonly root: string;
  readonly entries: readonly CodeTreeEntry[];
  readonly exclusions: readonly CodeExclusion[];
  readonly truncated: boolean;
}

/**
 * One file's contents.
 *
 * `text` IS NULL FOR TWO DIFFERENT REASONS AND THE UI MUST NOT CONFLATE THEM:
 * `binary` true means bytes that are not text, and `withheld` non-null means the
 * server's redaction self-check refused the file. Each gets its own sentence.
 */
export interface CodeFileResponse {
  readonly kind: "file";
  readonly runId: string;
  readonly path: string;
  readonly bytes: number;
  readonly text: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
  /** How many spans the server's redactor replaced. 0 = nothing matched. */
  readonly redactions: number;
  readonly withheld: string | null;
}

/* -------------------------------------------------------------------------
 * `GET /api/runs/:id/preview/*` — the built site, served BY THE DASHBOARD
 *
 * Transcribed from `server/src/api-types.ts`.
 *
 * DO NOT LINK TO `RunDetail.previewUrl`. It is a HISTORICAL RECORD, not a live
 * address: it is the `http://127.0.0.1:<port>` that a `deploy: true` run served
 * its workspace on, and the process that answered it exited with the run.
 * Measured on the one recorded run — `previewUrl` is `http://127.0.0.1:4321`,
 * nothing is listening, and the code is intact on disk. Anything that links there
 * links to nothing. This route is the live address, because the dashboard is by
 * definition running when someone is looking at its page.
 *
 *   /api/runs/:id/preview/            -> the workspace's index.html
 *   /api/runs/:id/preview/styles.css  -> that file, as text/css
 *   /api/runs/:id/preview/docs/       -> docs/index.html
 *   /api/runs/:id/preview             -> 302 to the form with the slash
 *
 * THE TRAILING SLASH IS LOAD-BEARING AND THE CLIENT MUST SEND IT. Without it the
 * browser resolves `styles.css` inside the document against `/api/runs/:id/` —
 * one level too high — and every relative asset 404s, so the page renders
 * unstyled and reads as a broken build. The server does answer the no-slash form
 * with a 302, so a link that forgets is slow rather than wrong; a link that
 * remembers is neither.
 *
 * WHAT COMES BACK IS BYTES, so there is no response interface here — open it in
 * an `<iframe>` or a tab. A REFUSAL is the same `{error, message, remediation}`
 * body every other route answers with, so render the server's sentence: it is
 * written to be actionable and the client has less information than it does.
 *
 * IT IS NOT A SANDBOX, and a client that frames it should say so to itself. The
 * document is served from the dashboard's own origin, so the run's JavaScript
 * runs there. The server sends `connect-src 'none'; form-action 'none'` to remove
 * the one capability the route creates — the previewed page calling this API —
 * and removes nothing else, because a preview that cannot render is not a
 * preview. Opening it in a NEW TAB wants `rel="noopener"`; framing it wants a
 * `sandbox` attribute if the client is willing to pay what that costs (an opaque
 * origin breaks ES modules and makes `localStorage` throw, which breaks a fair
 * number of generated sites).
 * ---------------------------------------------------------------------- */

/**
 * The refusal codes the preview route itself authors, and NOT the full set.
 *
 * Every other refusal it can answer with belongs to the server's
 * `code-files.ts` — `path_escapes_workspace`, `path_forbidden`, `no_workspace`,
 * `not_found` and the rest, the same ones `GET /api/runs/:id/files` answers with.
 * They are deliberately not enumerated: the server types that field as a plain
 * `string`, so a union claiming to list them would be a promise nothing checks.
 * These three are pinned at their construction sites on the server.
 *
 * `no_index_html` — 409, the one worth a bespoke rendering. The workspace exists
 * and has no `index.html`; the server's `remediation` names the `.html` files it
 * DID find, which is what tells a wrongly-named entry point apart from a build
 * that produced nothing. A run in this state has code worth opening in the file
 * browser, so offer that rather than a dead end.
 *
 * `invalid_encoding` — 400, a malformed `%` escape in the path.
 * `not_a_file` — 403, the path is neither a file nor a directory.
 */
export type PreviewOwnRefusalCode = "no_index_html" | "invalid_encoding" | "not_a_file";
