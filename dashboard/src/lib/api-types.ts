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

/**
 * `plan` IS FIRST BECAUSE IT RUNS FIRST, and the server's `ApiPhase` says why in
 * full: a question asked after the acceptance suite is frozen cannot change what
 * the run is graded against, so the only place it earns its keep is before the
 * spec seat.
 *
 * NOTHING MIGRATES ON THIS SIDE EITHER. The one consumer of the ORDER is
 * `presentation.ts`'s `PHASE_ORDER`/`phaseIndex`, whose only caller is
 * `components/run/header.tsx` — a file with no importer. Everything else reads
 * the phase as a value: `phaseMeta` switches on it, `spec-pipeline.ts` compares
 * it. A run recorded before this phase existed carries one of the original five
 * and renders exactly as it did.
 */
export type RunPhase = "plan" | "spec" | "build" | "review" | "gate" | "judge" | "done";

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

/**
 * One of the twelve machine gates every run is put through, in plain words.
 *
 * NOT A `RunCriterion`, AND NEVER TO BE COUNTED WITH ONE. A criterion is a
 * sentence written from the owner's own ticket; these twelve are identical on
 * every run of every ticket and nobody wrote them. They were invisible until
 * 2026-08-18 — the server recorded them and no table on this side held a row for
 * them — which is how a run could show "8 of 8 must-pass checks green" while one
 * of these was what failed it.
 *
 * `label` IS THE SERVER'S WORDS AND IS RENDERED AS SENT. It is composed in
 * `server/src/machine-checks.ts` so that this panel and anything else that ever
 * reports a gate say the same sentence. Do not restate it here.
 *
 * `detail` IS PRESENT ONLY WHERE IT IS BOTH ALLOWED AND USEFUL: a failed check
 * whose detail comes from the artefact's own toolchain. The three gates whose
 * details quote the held-out runner or name locked files always send `null`, and
 * so does every passing check. Render it as a second line under a failed row, or
 * not at all — never as the reason for a check that passed.
 */
export interface MachineCheck {
  /** The grader's join key, e.g. `GATE:build`. Not for the screen. */
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string | null;
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
 * ONE FILE THE OWNER ATTACHED TO A TICKET — the server's `ApiAttachment`,
 * mirrored by hand.
 *
 * `url` IS THE ONLY FIELD A BROWSER CAN USE. `path` is an absolute HOST path,
 * like `Screenshot.path` and `artifactPath`; `url` is same-origin and route-
 * relative (`/api/runs/:id/references/:file`), so it goes through `apiUrl()`
 * for the same reason `screenshotSrc` reads `API_BASE` — the browser specs run
 * the app and the API on different loopback ports.
 *
 * `mediaType` IS BYTE FOR BYTE THE `Content-Type` THE ROUTE ANSWERS WITH,
 * charset and all. The server derives both from one function, so deciding how
 * to render from this field cannot be told one thing and sent another; that is
 * why `attachments.tsx` switches on it rather than on the extension.
 *
 * `file` IS NOT THE NAME THE OWNER PICKED. Intake takes base64 data URLs, which
 * carry no filename, so the browser discards `Kamil_Borzecki_CV.pdf` before the
 * POST and the server only ever knows the ordinal name it minted
 * (`document-1.pdf`). Renderers must not present it as the owner's own name.
 */
export interface Attachment {
  /** The server-minted filename, and the last segment of `url`. */
  readonly file: string;
  /** Absolute host path. Builder-facing; a browser cannot open it. */
  readonly path: string;
  /** sha256 of the bytes — this is what entered the ticket id. */
  readonly sha256: string;
  /** Size as digested at intake, not as `stat`ed now. */
  readonly bytes: number;
  /** Byte for byte the `Content-Type` the route answers with. */
  readonly mediaType: string;
  /** Same-origin, no host. Route-relative; pass it through `apiUrl()`. */
  readonly url: string;
}

/**
 * WHICH OF THE TWO STAGES the DESIGN lane is in — the server's `ApiDesignStage`.
 *
 * `none` is EVERY RUN RECORDED BEFORE 2026-08-03 and every run whose lane
 * offered no directions at all. It is not a degraded reading: the panel renders
 * exactly what it rendered before directions existed.
 *
 * `canvass`   the lane offered N distinct directions and none is chosen yet.
 *             This is the park the owner is being asked to answer.
 * `expanding` a direction is chosen and the lane is rendering the rest of its
 *             sections. NOT "nothing was locked" — see `designLockPhase`, which
 *             would otherwise print exactly that for the whole window.
 * `settled`   the expansion returned.
 */
export type DesignStage = "none" | "canvass" | "expanding" | "settled";

/**
 * ONE of the distinct directions the canvass offered — the server's
 * `ApiDesignDirection`, mirrored by hand.
 *
 * `mockups` CARRIES PUBLISHED COPY PATHS, byte-identical to the strings in
 * `DesignLockState.mockups[].path`. That identity is the whole grouping
 * mechanism on this side: a `Set` of these paths partitions the flat mockup list
 * with no filename parsing and no third mirrored literal (`lib/mockups.ts`
 * already carries two, and both fail soft on purpose).
 *
 * `notes` IS THE ONLY THING A DEGRADED RUN HAS. With no image key the lane
 * writes art direction instead of stills, so `mockups` is empty and `notes`
 * names the `direction-<slug>.md` it wrote. A panel that renders directions only
 * when there are images shows a degraded owner nothing to choose from.
 */
export interface DesignDirectionState {
  readonly slug: string;
  readonly name: string;
  /** ONE sentence on what makes this different from the others. */
  readonly distinction: string;
  /** Offered, not built. Never graded against, never shown as though it were built. */
  readonly discarded: boolean;
  /** PUBLISHED copy paths, matching `DesignLockState.mockups[].path` exactly. */
  readonly mockups: readonly string[];
  /** Absolute HOST path of this direction's written art direction, or null. */
  readonly notes: string | null;
}

/**
 * ONE on-demand render the owner asked for while parked — the server's
 * `ApiDesignRenderRequest`, mirrored by hand.
 *
 * `outcome` IS OPEN VOCABULARY, `gateStopReason`'s precedent. The server's set
 * today is `rendered`, `rendered-off-brief`, `unknown-direction`, `no-section`,
 * `turn-cap`, `render-cap`, `failed`; it is typed `string` on both sides
 * deliberately, so EVERY renderer needs a default branch. A value this build has
 * never heard of is a newer server, not a bug.
 *
 * `mockup` IS THE PUBLISHED COPY or null — null is an outcome that produced no
 * image (a refusal, or a generation that failed), and it still spent its render.
 */
export interface DesignRenderRequest {
  readonly at: string;
  readonly section: string;
  readonly direction: string;
  readonly outcome: string;
  readonly detail: string;
  readonly mockup: string | null;
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
 *
 * ══ THE NINE FIELDS ADDED ON 2026-08-03 ARE ABSENT FROM EVERY RECORDED RUN ══
 *
 * And that is not a theoretical absence. `lib/api.ts` casts every response with
 * `parsed as T` and validates NOTHING, so this type lies at runtime about the
 * three runs already on disk: measured against the running backend on
 * 2026-08-02, `GET /api/runs/run-2026-07-30T20-16-40-242Z-052c6e02` answers with
 * a `designLock` carrying five keys and none of these. `lock.directions.length`
 * on that body is a TypeError inside a render — a blank page on the screen whose
 * job is showing a reader what happened.
 *
 * SO EVERY ARRAY BELOW IS READ `?? []` AND `stage` IS READ `?? "none"` AT THE
 * POINT OF USE. `lib/mockups.ts` exports `directionsOf`, `requestsOf` and
 * `stageOf` for exactly that, and they are the sanctioned readers; a component
 * that touches these fields directly is one old run away from a blank page.
 */
export interface DesignLockState {
  /** The run is parked RIGHT NOW waiting for a mockup to be chosen. */
  readonly awaiting: boolean;
  readonly mockups: readonly Screenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
  /** `[]` on every run before 2026-08-03; `stage` is then `"none"`. */
  readonly directions: readonly DesignDirectionState[];
  readonly chosenDirection: string | null;
  readonly chosenDirectionBy: "owner" | "ui-designer" | "fallback" | null;
  readonly stage: DesignStage;
  /** Owner turns spent at this park, and the cap. Every claimed message costs one. */
  readonly turnsUsed: number;
  readonly turnsMax: number;
  /** On-demand generations spent on this RUN, and the cap. A failure still spends one. */
  readonly rendersUsed: number;
  readonly rendersMax: number;
  readonly requests: readonly DesignRenderRequest[];
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

export interface Context7Evidence {
  readonly claimId: string;
  readonly package: string;
  readonly versionOrRange: string | null;
  readonly queryPurpose: string;
  readonly success: boolean;
  readonly evidenceHash: string;
  readonly seat: string;
}

export interface Context7Lifecycle {
  readonly claimId: string | null;
  readonly seat: string;
  readonly obligationHash: string;
  readonly server: string;
  readonly tool: string | null;
  readonly state: string;
  readonly code: string | null;
  readonly producedArtefactHashes: readonly string[];
}

export interface Context7Finding {
  readonly claimId: string;
  readonly severity: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
}

export interface Context7ClaimReference {
  readonly claimId: string;
}

export interface Context7Verdict {
  readonly verdict: "pass" | "fail";
  readonly summary: string;
  readonly findings: readonly Context7Finding[];
  readonly evidence: readonly Context7ClaimReference[];
}

export interface Context7Package {
  readonly package: string;
  readonly versionOrRange: string | null;
}

export interface Context7Source {
  readonly sourceHash: string;
  readonly files: readonly string[];
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Independent review evidence. It never changes heldOutPass.
 * Unsatisfied means required documentation evidence was missing, so no review
 * verdict was admitted.
 */
export interface Context7Review {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "completed" | "capability_unavailable" | "unsatisfied" | "failed";
  readonly capabilityApplicability: "not_applicable" | "suggested" | "required";
  readonly code: string | null;
  readonly packages: readonly Context7Package[];
  readonly source: Context7Source;
  readonly verdict: Context7Verdict | null;
  readonly evidence: readonly Context7Evidence[];
  readonly lifecycle: readonly Context7Lifecycle[];
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
 * `dashboard/runs/<37-character run id>/workspace/`, which the owner said he
 * cannot find and which does not read as his project. On a terminal run the
 * server copies it to `projects/<slug-of-the-ticket-title>/`.
 *
 * (37, MEASURED — this docblock said 44 until 2026-08-02, as three others still
 * do. The id is built at `server/src/http.ts` as `run-<ISO instant with : and .
 * replaced by ->` plus a dash and 8 uuid characters: 4 + 24 + 1 + 8. Checked
 * against a freshly minted id and against the one run on this machine that
 * reached a verdict, `run-2026-07-30T20-16-40-242Z-052c6e02`. NOTHING TESTS THE
 * MINTER — `server/src/publish-wiring.test.ts` pins only its own fixture's
 * length — so treat this as arithmetic off the format, not as a checked fact.)
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

/**
 * ONE QUANTIZED THING THE REFERENCE PAGE WAS OBSERVED TO DO — the server's
 * `ApiMotionEntry`, mirrored by hand.
 *
 * EVERY NUMBER IS A BUCKET, NOT A MEASUREMENT, and a renderer may not undo the
 * rounding. `durationMs` is to the nearest 50 ms and `staggerMs` to the nearest
 * 20 ms; `scrollRatio` is two decimals. Two readings of the same page do not
 * agree more precisely than that, which is why the buckets exist — so print
 * "about 500ms", never "exactly 500ms".
 *
 * `parity: false` MEANS THE CONTENT WAS NEVER COMPARED. Two families are
 * presence-only (route transitions, canvas/WebGL repaints): they were observed
 * to run, and their `durationMs` describes the sampling window rather than a
 * declared animation. Rendering their numbers like a scroll reveal's is
 * inventing a measurement; the server's own brief prose says "presence only" for
 * exactly these rows.
 *
 * `family` IS `string` ON BOTH SIDES, deliberately — the vocabulary is twelve
 * names today and a renderer needs a default branch for a thirteenth a newer
 * server sends.
 */
export interface ApiMotionEntry {
  readonly family: string;
  /** A ROLE, never a selector and never a path — `h1`, `div.card`. */
  readonly role: string;
  /** The properties observed changing, sorted: `opacity`, `transform`. */
  readonly props: readonly string[];
  /** Bucketed to 50 ms. Never an exact measurement. */
  readonly durationMs: number;
  /**
   * Bucketed to 20 ms, or `null` when the role had NO SIBLINGS to be staggered
   * against. `null` is not `0`: zero would say the siblings moved together.
   */
  readonly staggerMs: number | null;
  /** A named curve — `ease-out`, `linear` — never a raw cubic-bezier. */
  readonly easing: string | null;
  /** `null` means it repeats without end, which is why it is not `0`. */
  readonly iterations: number | null;
  /** Px moved per px scrolled, two decimals. Only scroll-linked motion has one. */
  readonly scrollRatio: number | null;
  /** False for the presence-only families. See this interface's docblock. */
  readonly parity: boolean;
}

/**
 * A reading of how a REFERENCE PAGE MOVES, taken once when the ticket was
 * submitted — the server's `ApiMotionSpec`, mirrored by hand.
 *
 * THE NAME KEEPS ITS `Api` PREFIX, unlike every other mirror in this file, and
 * that is on purpose: the server also has a `MotionSpec` carrying the raw
 * reading (absolute start times, unrounded floats) which never reaches the wire.
 * A client type called `MotionSpec` would read as that one.
 *
 * IT IS A SAMPLE, NOT AN INVENTORY. An empty `entries` means "nothing was
 * observed to move inside the sampling window", never "this page is static" —
 * so do not render it as "no animation found".
 *
 * THE SERVER SENDS IT SINCE 2026-08-04, off the run's reference manifest, for
 * any ticket submitted with a `motionUrl` that could be read. It is rendered by
 * `components/run/motion.tsx` on the RunSheet's Ticket tab, which
 * `tests/motion-readout.browser.spec.ts` drives against all three states and a
 * body carrying no `motion` key at all. That spec, not `contract-parity`, is
 * what proves a renderer exists: parity compares two declarations and passed on
 * the day this field arrived with nothing reading it.
 */
export interface ApiMotionSpec {
  readonly url: string;
  /** When the reading was taken, ISO-8601. Not when the page last changed. */
  readonly capturedAt: string;
  readonly entries: readonly ApiMotionEntry[];
  /** Motion libraries detected on the reference, sorted. Names what it used. */
  readonly libraries: readonly string[];
  /** Whether the REFERENCE honours prefers-reduced-motion. Not whether we do. */
  readonly respectsReducedMotion: boolean;
}

export interface RunDetail extends RunSummary {
  readonly ticketText: string;
  readonly phase: RunPhase;
  readonly criteria: readonly RunCriterion[];
  /**
   * The twelve machine gates, or `null` when this run never reached them.
   *
   * `null` IS NOT `[]` AND MUST NOT RENDER LIKE IT. `null` is "the gate has not
   * run" — queued, building, parked, cancelled before it, or a gate that could
   * not run at all — and the panel says so in words. `[]` would mean a gate that
   * ran and reported nothing, which never happens: a gate that runs produces all
   * twelve. Twelve rows always arrive in the same order, so a missing check is
   * still a row (a failed one) rather than a gap in the list.
   *
   * A BODY WITH NO KEY AT ALL IS ALSO REAL. `lib/api.ts` casts responses without
   * validating them, and every run recorded before this field existed answers
   * without it, so mount sites read `machineChecks ?? null` — the same
   * flattening `designLock` and `adversary` get.
   */
  readonly machineChecks: readonly MachineCheck[] | null;
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
  /**
   * The REFERENCE IMAGES the owner attached to this ticket, each with a URL.
   *
   * NOT `designLock.mockups`, AND THE TWO MUST NEVER SHARE A HEADING. Those are
   * images `ui-designer` GENERATED for this run — "what did the machine
   * propose"; these are the owner's own uploads — "what did I hand it". They are
   * kept on different tabs of `RunSheet` for that reason: mockups render inside
   * `ScreenshotsPanel` on Verdict, these render in `TicketAttachmentsPanel` on
   * Ticket, so no screen can put them side by side.
   *
   * FOLDED PER REQUEST FROM THE REFERENCE MANIFEST ON DISK, never from the run
   * row — the bytes and digests were never in SQLite. So an empty list means
   * "none attached" OR "the manifest could not be read", which is the server's
   * existing flattening; the distinction a renderer needs — is there anything to
   * show — survives it.
   *
   * ABSENT ENTIRELY ON EVERY RUN RECORDED BEFORE THESE ROUTES EXISTED, and that
   * is not theoretical: measured on 2026-08-02 against the running backend,
   * `GET /api/runs/run-2026-07-30T20-16-40-242Z-052c6e02` returns a body with
   * neither key. `lib/api.ts` does `parsed as T` with NO runtime validation, so
   * the type below lies about that payload at runtime. Read it as
   * `run.references ?? []` at the call site, the way `adversary` is read
   * `?? null` — see `RunSheet`'s Ticket tab.
   */
  readonly references: readonly Attachment[];
  /**
   * The DOCUMENTS the owner attached — a scope, a brief, a CV. Same folding,
   * same flattening and the same absent-on-old-runs trap as `references`.
   *
   * A URL HERE MEANS THE OWNER CAN READ IT. WHICH SEATS ALSO READ IT IS A
   * SHORTER LIST THAN "the run". What is certain is that the digest of each of
   * these entered the ticket id, so changing one re-authors the acceptance
   * suite.
   *
   * THE SEATS, READ OFF `orchestrator.ts` ON 2026-08-02 rather than inferred:
   * `#seatDocuments` has three call sites — `#planOpening` and `#planFollowUp`
   * (the PLAN seat, opening and every follow-up turn) and `#specPhase` (the SPEC
   * seat, on every call it makes). The audit/judge caller is built WITHOUT them
   * deliberately, and so is the builder. The server's own `documents` docblock
   * carries the full reasoning and the cost of that exclusion.
   *
   * THE PLAN SEAT IS GATED, THE SPEC SEAT IS NOT. `planPolicy(interactive)` is
   * `skip` for a run that did not come from the dashboard, and that branch makes
   * no plan-seat call at all — so on a CLI or cron run the first two sites never
   * happen. Only the spec seat is on the unconditional path.
   *
   * SO DO NOT WRITE "the run has read your scope" IN A SUBTITLE — it is true of
   * some seats and false of others, and only the run's own log says what a given
   * run did. Note `http.ts`'s intake `warn` still says STORED, NOT READ; it is
   * the stale half of that pair and is not the sentence to mirror.
   */
  readonly documents: readonly Attachment[];
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
  /**
   * The independent review record. Older runs and non-pilot servers omit it at
   * runtime, so renderers must read context7Review ?? null.
   */
  readonly context7Review?: Context7Review | null;
  /**
   * How the page the owner named as a MOTION REFERENCE was observed to move, or
   * `null` when this ticket named none.
   *
   * `null` NOW MEANS WHAT IT SAYS: no reading was taken for this run — no
   * `motionUrl` was submitted, or the address was refused, or the browser would
   * not start. The server's `toDetail` filled this field from the reference
   * manifest on 2026-08-04; before that it hardcoded `null` and this paragraph
   * warned that the absence was about the server rather than about the owner.
   *
   * A SPEC WITH AN EMPTY `entries` IS NOT THAT. It means a page WAS read and
   * nothing moved inside the sampling window, which is a fact about the
   * reference; collapsing the two in a renderer would report an opened,
   * watched page as an ignored one.
   *
   * `MotionReadoutPanel` (`components/run/motion.tsx`) READS IT, mounted on the
   * RunSheet's Ticket tab beside `TicketAttachmentsPanel`. It went unread for
   * the first hours of its existence — the `references`/`documents` shape at its
   * second stage, where the data arrives and no component renders it — and the
   * check that closed that is a browser one, `tests/motion-readout.browser.spec.ts`,
   * because a type parity test passes while a field renders nowhere.
   *
   * ABSENT ENTIRELY ON EVERY RUN RECORDED BEFORE THIS FIELD EXISTED — the same
   * trap `references` and `documents` carry, and for the same reason:
   * `lib/api.ts` does `parsed as T` with NO runtime validation, so this type
   * lies about an old payload. Read it `run.motion ?? null` at the call site.
   *
   * READ `ApiMotionSpec` BEFORE RENDERING ANY OF IT. Every number is a bucket,
   * an empty `entries` is not "the page is static", and the presence-only rows
   * carry numbers about the sampler rather than about the page.
   */
  readonly motion: ApiMotionSpec | null;
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
  /**
   * A page whose MOTION the owner wants matched — and whose content he does not.
   *
   * NOT `captureUrl`, AND NEVER THE SAME CONTROL. `captureUrl` means "copy this
   * site": its outline is composed into the ticket text and its screenshots go
   * to the builder. This one means only "move like this", and a form that fed
   * one string to both would make "I like how this moves" also say "build me its
   * pages".
   *
   * ABSENT AND `null` MEAN THE SAME THING HERE — no motion reference. There is
   * no ticket-text scan for this field, unlike `captureUrl`, so an empty input
   * must send NO KEY rather than an empty string: five browser specs assert the
   * whole POST body with `toEqual`, and an unconditional key reddens all of
   * them. `page.tsx` spreads it conditionally for exactly that reason.
   *
   * IT MAKES THE POST SLOWER. The server opens the page and watches it move
   * inside this request, on top of whatever `captureUrl` already costs, and the
   * response does not come back until it is done.
   *
   * A FAILED READING STILL CREATES THE RUN; the reason arrives as a `warn` on
   * the run's event stream. What was read comes back on `RunDetail.motion` and
   * is shown by `MotionReadoutPanel` on the RunSheet's Ticket tab, so a form
   * that promises a readout now names a screen that exists. A DECLINE HAS NO
   * SCREEN OF ITS OWN: the panel renders nothing for `motion: null`, and that
   * `null` covers a refused address and a browser that would not start as well
   * as a ticket that named no reference. The event stream is the only place the
   * difference is stated.
   */
  readonly motionUrl?: string | null;
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
 * One hunk of a unified diff — the SDK's `structuredPatch[n]`, field for field.
 *
 * `lines` CARRIES THE LITERAL `" "` / `"+"` / `"-"` PREFIXES, which is the SDK's
 * own encoding and what makes a coloured render a `startsWith` rather than a
 * second array of flags that can disagree with the text.
 *
 * A LINE MAY ARRIVE PARTIALLY REWRITTEN, AND THAT IS NOT CORRUPTION. Every
 * persisted event goes through the server's credential redactor, whose
 * high-entropy and base64 rules match a lockfile's `sha512-…` integrity line, a
 * minified bundle and an inlined data URL. `[REDACTED:HIGH_ENTROPY_TOKEN]` inside
 * a diff line is the redactor working; rendering it verbatim is correct and
 * "repairing" it is a credential leak.
 */
export interface GraphDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/**
 * One APPLIED file edit — the green and red lines.
 *
 * THE COUNTS ARE ALWAYS EXACT; THE BODY IS NOT ALWAYS WHOLE. `additions` and
 * `deletions` count the FULL patch; `hunks` is what fitted the wire budget. When
 * they disagree `capped` is true, and a capped diff drawn as if it were whole is
 * the failure this flag exists to prevent — say "12 of 340 lines" or say nothing.
 *
 * `path` IS WORKSPACE-RELATIVE. The server's fold rewrites the host home prefix to
 * `~`; the credential redactor does NOT cover paths, so that scrub is the only
 * thing standing between the owner's home directory and this browser.
 *
 * NOTHING PRODUCES ONE OF THESE FOR A `Bash`-DRIVEN EDIT — `sed -i`, a heredoc,
 * `npm init` — because the SDK computes no patch for them. A file that changed
 * with no diff card is not a bug and the UI must say so rather than implying the
 * list is complete.
 */
export interface GraphDiff {
  readonly path: string;
  readonly change: "added" | "modified";
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly GraphDiffHunk[];
  /** True when a hunk, a line, or part of a line was withheld. */
  readonly capped: boolean;
  readonly droppedHunks: number;
  readonly droppedLines: number;
}

/**
 * The pre-build lane, left to right, ending at the hand-off to the agent graph.
 *
 * `orchestrator` is the owner's ask literally: "Planning (node) ----- Orchestrator
 * (node) ------ (then whatever the orchestrator spawns)". It is a member of the
 * same list so the renderer draws one chain.
 */
export type GraphStageId =
  | "plan"
  | "capture"
  | "author"
  | "audit"
  | "freeze"
  | "orchestrator";

/**
 * `unresolved` = the run moved on, or ended, while this stage still read
 * `running`, and nothing ever said how it finished. NOT `failed`, and not
 * `pending`, which on a finished run reads as "still to come".
 */
export type GraphStageState = "pending" | "running" | "done" | "skipped" | "unresolved";

export interface GraphStage {
  readonly id: GraphStageId;
  readonly label: string;
  readonly detail: string;
  readonly state: GraphStageState;
  /** ISO instant of the row that set this state, or null when it carried none. */
  readonly at: string | null;
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
  /**
   * FOUR KINDS IN ONE LIST, IN THE ORDER THEY HAPPENED — prose, a tool call, a
   * diff, more prose. That interleaving is what the Claude Code terminal shows and
   * it is the feature; three parallel lists would have to be merged back by `at`,
   * which is nullable and therefore cannot always do it.
   *
   * PINNED AS A LITERAL UNION BY `contract-parity.test.ts`. Widening it to
   * `string` here would mirror the field and lose the branch this renders on.
   */
  readonly kind: "tool" | "skill" | "narration" | "diff";
  /** Tool or skill name. `diff` carries the tool; `narration` carries `""`. */
  readonly name: string;
  readonly detail: string;
  readonly truncated: boolean;
  /** The edit's body. PRESENT IF AND ONLY IF `kind` is `"diff"`. */
  readonly diff?: GraphDiff;
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
  /*
   * The pre-build lane — see `GraphStage` above.
   *
   * NO BRACE OF ANY KIND IN THIS BLOCK, AND THAT IS NOT A STYLE CHOICE.
   * `contract-parity.test.ts` reads this interface with a parser that slices RAW
   * text to the first closing brace and strips comments only afterwards, so a
   * brace inside a docblock — an at-link, most easily — truncates the region and
   * every field below it vanishes from the comparison. The same trap is recorded
   * in that file's own `fieldNames` docblock, where an at-link inside a comment
   * made a five-field interface parse as two.
   *
   * IT LIVES HERE, AND NOT IN `spec-pipeline.ts`, BECAUSE OF WHERE THAT READ FROM.
   * The old projection derived these stages from the live `trace` sink, and
   * `use-run-stream.ts` never opens a socket for a terminal run — so the lane was
   * blank on every run the owner opened after it finished, which is most of them.
   * `foldGraph` is the one reducer behind both the durable snapshot and the live
   * tail, so a stage folded there is identical on replay and live by construction.
   *
   * ABSENT MEANS THE STREAM NEVER MENTIONED A PRE-BUILD LANE, and it is never the
   * empty array — `undefined` and `[]` are not two spellings of one fact. A run
   * whose first `phase` row is `build` folds to a state with no `stages` key,
   * exactly as it already folds to an empty canvas.
   *
   * READ IT AS `state.stages ?? []`. It is optional only because four object
   * literals outside the lane that added it build a `GraphState` field by field —
   * `use-run-graph.ts:204` is the dangerous one, since it rebuilds the SNAPSHOT
   * and would drop the stages on the one path a finished run has. Making it
   * required is five lines and is described at the server's declaration.
   */
  readonly stages?: readonly GraphStage[];
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
      /**
       * Which seat the provider was answering, or `null` when the frame did not
       * say. MIRRORS `ApiSpendSeat | null` ON THE SERVER'S `SseEvent`, and the
       * word "mirrors" is doing real work: `dashboard/src/lib/graph.ts` imports
       * from `../../server/src/graph`, so the server's union is inside this
       * program and a mirror that omits a REQUIRED member is a type error, not a
       * cosmetic drift. It was omitted once, and `npx tsc --noEmit` went from 0
       * to 7 errors while all 259 browser tests stayed green over it — the
       * playwright loader is transpile-only and cannot see a type break.
       *
       * REQUIRED AND NULLABLE, not optional. `seat?:` does not satisfy the
       * server member under `exactOptionalPropertyTypes`, and optional would
       * also let a construction site forget the field silently, which is exactly
       * how the six anonymous `rate_limit` rows in run `a913c871` came to be.
       */
      readonly seat: SpendSeat | null;
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
    }
  /**
   * WHAT THE MODEL SAID, IN ITS OWN WORDS, FOR ONE TURN — ask B's achievable half.
   *
   * ITS OWN TYPE BECAUSE THE CHANNEL IT SHARED WAS THE BUG. The builder already
   * captures this and posts it as a generic `{type:"log", level:"info"}` — the
   * same shape, the same level and the same channel as `spec seat — anthropic: 14
   * input, 40187 cache read…`. No renderer can tell an agent explaining itself
   * from a token count, so both get the same grey line or neither does.
   *
   * IT IS NOT THINKING AND MUST NOT BE LABELLED AS THINKING. 7,037 `thinking`
   * blocks were counted across four models in the local corpus and every one of
   * them is empty; the `signature` beside them is encrypted and no SDK option
   * decrypts it. This is the assistant's visible prose, which is most of what the
   * terminal shows anyway.
   *
   * NO LEVEL, DELIBERATELY. Narration has no severity — a model saying "this looks
   * wrong, let me check" is not a warning — and giving it one would recreate the
   * confusion the type exists to end.
   */
  | {
      readonly type: "graph_narration";
      readonly node: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly attribution: GraphAttribution;
      readonly at?: string;
    }
  /**
   * ONE APPLIED FILE EDIT — ask C. See {@link GraphDiff} before rendering it: the
   * counts are whole, the body may not be, and `capped` is the only thing that
   * says which.
   */
  | {
      readonly type: "graph_diff";
      readonly node: string;
      readonly path: string;
      /** The CLI's own tool name — `Edit`, `Write`, `NotebookEdit`. */
      readonly tool: string;
      readonly change: "added" | "modified";
      readonly additions: number;
      readonly deletions: number;
      readonly hunks: readonly GraphDiffHunk[];
      readonly capped: boolean;
      readonly droppedHunks: number;
      readonly droppedLines: number;
      readonly attribution: GraphAttribution;
      readonly at?: string;
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
  "plan",
  "spec",
  "build",
  "review",
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

/* -------------------------------------------------------------------------
 * `/api/projects` — the published folders, and the processes serving them
 *
 * Mirrored BY HAND from `server/src/api-types.ts` (`ApiProject*`), like every
 * other shape in this file. `contract-parity.test.ts` pins the SSE union,
 * RunDetail's design-lock/gate fields and the spend record and NOTHING HERE —
 * grepped, not assumed — so nothing goes red if the server renames one of these.
 * Read the server's docblocks before changing a field name.
 *
 *   GET  /api/projects              -> ProjectsResponse
 *   POST /api/projects/:slug/start  -> ProjectStartResponse  (or a refusal)
 *   POST /api/projects/:slug/stop   -> ProjectStopResponse   (or a refusal)
 *   GET  /api/projects/:slug/logs   -> ProjectLogs
 *
 * THE TWO POSTS ARE ORIGIN-CHECKED. The server refuses a present, non-loopback
 * `Origin` with 403 `cross_origin_write`, because their effect is a process
 * spawned or killed. Measured 2026-08-02 through `next.config.ts`'s rewrite: a
 * POST carrying `Origin: http://127.0.0.1:4319` — which is what this app's own
 * fetches send — reaches the runner (it came back 409 `not_running`, the state
 * refusal, not the origin one). So the rewrite preserves the header and the
 * dashboard's own page is allowed.
 * ---------------------------------------------------------------------- */

/**
 * HOW A CHILD ENDED — the server's `ApiProjectExit`.
 *
 * `requested` IS THE WHOLE FIELD. `true` is a receipt for a stop the owner
 * asked for; `false` is a process that died on its own, which is the case a
 * calm "stopped" chip would hide. Never render the two the same way.
 */
export interface ProjectExit {
  readonly at: string;
  /** Null when a signal ended it; `signal` is then non-null. */
  readonly code: number | null;
  readonly signal: string | null;
  readonly requested: boolean;
}

/**
 * THREE STATES, AND THE THIRD IS THE POINT — the server's `ApiProjectProcess`.
 *
 * `stopped` nothing of ours is running. `lastExit === null` = this dashboard
 *           never started it; `lastExit.requested === true` = the owner stopped
 *           it. Two different sentences.
 * `running` a child is alive AND the URL answered an HTTP request at `readyAt`.
 *           The server never sets it on the strength of a successful spawn.
 * `exited`  a child we started died WITHOUT being asked to.
 *
 * `url` EXISTS ONLY ON THE `running` MEMBER, and that is the mechanism rather
 * than a convention: a renderer structurally cannot offer a link to open before
 * the server has measured that the port answers. Do not lift it out of the
 * union, and do not build an address from `port` on any other member.
 *
 * WHAT `running` DOES NOT CLAIM: that the URL answers RIGHT NOW. It answered at
 * `readyAt` and the process was alive when the response was built.
 *
 * THERE IS NO `starting` MEMBER, deliberately — readiness is measured inside the
 * start request, so "starting" is the client's own in-flight state and belongs
 * to whichever component holds the promise. See `project/controls.tsx`.
 */
export type ProjectProcess =
  | { readonly state: "stopped"; readonly lastExit: ProjectExit | null }
  | {
      readonly state: "running";
      /** `http://127.0.0.1:<port>` — loopback, always. */
      readonly url: string;
      readonly port: number;
      readonly pid: number;
      readonly startedAt: string;
      /** When the port actually answered. */
      readonly readyAt: string;
    }
  | {
      readonly state: "exited";
      readonly port: number;
      readonly startedAt: string;
      readonly exit: ProjectExit;
    };

/**
 * One folder under `projects/` — the server's `ApiProject`.
 *
 * `startCommand` IS NULL WHEN NOTHING HERE CAN BE STARTED (no `package.json`, or
 * one with no `start` script). READ IT BEFORE OFFERING A START BUTTON: the
 * route's refusal for that case is a 409 the owner should never have to see.
 *
 * `runId` is the run that published this folder, found by reading each run's own
 * publish record. Null means no record names it — a folder the owner made
 * himself, or one published before the record existed. It is also the join key
 * back to a run: prefer it over comparing `path` against
 * `PublishedProject.path`, because the two sides realpath differently.
 *
 * `path` is an absolute HOST path. A browser cannot open it — the same rule as
 * `artifactPath` and `PublishedProject.path`. `process.url` is the only address
 * on this type that is a link.
 */
export interface Project {
  /** The directory name under `projects/`. The only id the API accepts. */
  readonly slug: string;
  readonly path: string;
  /** e.g. `npm start`. Null when nothing here can be started. */
  readonly startCommand: string | null;
  /** True when the folder has its own git repository (the handover's, or the owner's). */
  readonly hasRepository: boolean;
  readonly runId: string | null;
  readonly process: ProjectProcess;
}

/**
 * SORTED BY SLUG, ALPHABETICALLY — measured against the running server, and it
 * matters because nothing on `Project` carries a timestamp. A list that wants
 * newest-first has to join `runId` to the runs list for a time; see
 * `app/projects/page.tsx`, which does exactly that and falls back to this order
 * when the runs list has not arrived.
 */
export interface ProjectsResponse {
  readonly projects: readonly Project[];
  /** The loopback port window children are allocated from, inclusive. */
  readonly portRange: { readonly min: number; readonly max: number };
}

/**
 * `started: false` WITH A `running` PROCESS IS THE ALREADY-RUNNING ANSWER — the
 * existing URL, and no second child. It is a 200 rather than a refusal because
 * the caller asked for a running project and got one.
 */
export interface ProjectStartResponse {
  readonly started: boolean;
  readonly project: Project;
}

export interface ProjectStopResponse {
  readonly stopped: boolean;
  readonly project: Project;
}

export interface ProjectLogLine {
  readonly stream: "stdout" | "stderr";
  readonly at: string;
  readonly text: string;
}

/**
 * RECENT output, bounded and redacted by the server. `dropped` is how many lines
 * fell off the front — render it, because a window that does not say what it
 * lost is a lie about volume.
 *
 * A project that never ran answers with an EMPTY list rather than a refusal.
 * "Nothing was recorded" is the truthful answer to the question that was asked.
 */
export interface ProjectLogs {
  readonly slug: string;
  readonly lines: readonly ProjectLogLine[];
  readonly dropped: number;
  readonly maxLines: number;
}


/* ------------------------------------------------------------------ */
/* THE SUPERVISOR — additive route, DESIGN §7.6.2                      */
/* ------------------------------------------------------------------ */

/**
 * `GET  /api/supervisor`             -> SupervisorState
 * `POST /api/supervisor/start|stop`  -> SupervisorCommandResponse
 *
 * THIS BLOCK IS A MIRROR OF `server/src/api-types.ts`'s `ApiSupervisor*`, NOT A
 * DESIGN. Field for field, name for name, nullability for nullability.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT WAS NOT A MIRROR WHEN IT SHIPPED, AND THE COST IS WHY THIS PARAGRAPH IS
 * LONGER THAN THE TYPES (corrected 2026-08-10, second pass).
 *
 * The first version was written against DESIGN §7.6.2 rather than against
 * `ApiSupervisorState`, and it disagreed with the wire in FIFTEEN fields:
 * `since`/`changedAt`, flat `runId`+`runStatus`+`phase` against a nested `run`,
 * `quietForSeconds` against `run.quietForMs`, `queuedTickets` against
 * `queueDepth`, `lastDefectSignature` against `lastDefect`+`lastDefectId`, a
 * non-nullable `lastRepair` carrying `summary`+`signature` against a nullable
 * one carrying neither, `ticket.currentRunId` which the wire has never sent, and
 * four wire fields nothing here declared at all (`at`, `attempts`, `lastPatchId`,
 * `probe.unsourced`).
 *
 * MEASURED CONSEQUENCE, against a real server on an APFS clone of the owner's
 * home: every page read amber `MALFORMED` and named eight absent fields — the
 * strip built to tell WORKING from STUCK reported the same amber when the loop
 * was healthy as when it was wedged. Three green typecheckers could not see it,
 * because nothing imports both declarations, and neither suite could, because
 * `tests/fixtures/` serves no `/api/supervisor` at all.
 *
 * SO THE PIN IS NOT A COMMENT ANY MORE. `tests/fixtures/supervisor-wire.golden.json`
 * was GENERATED by running the server's own `composeSupervisorState`, and it is
 * asserted from both ends: `server/src/supervisor-route.test.ts` deep-equals the
 * composer's output against it (server drift goes red there) and
 * `tests/supervisor-strip.unit.spec.ts` drives `classifySupervisor` with it
 * (a drift in THIS file goes red here). A hand-written golden would have been a
 * third mirror and the same defect one layer up.
 *
 * `npx tsc --noEmit` IN THIS PACKAGE IS STILL PART OF THE HANDOFF: Playwright's
 * loader is transpile-only, so a browser suite can be entirely green against a
 * mirror that no longer compiles.
 *
 * `T | null`, NEVER `T?`. "The supervisor says there is no run" and "the field
 * is missing" must not collapse into one `undefined`.
 */
export type SupervisorDesired = "running" | "draining" | "stopped";

/**
 * `state` IS A STRING, NOT A UNION, AND THAT IS THE SERVER'S CHOICE MIRRORED
 * FAITHFULLY. `ApiSupervisorTicket.state` is documented as
 * `queued|claimed|running|repairing|waiting|blocked|done|abandoned` and typed
 * `string`. Narrowing it here would make this file disagree with the wire the
 * first time the server adds a ninth state, and the disagreement would surface
 * as a client-side type error on data that is perfectly valid.
 */
export interface SupervisorTicket {
  readonly ticketKey: string;
  readonly title: string;
  readonly state: string;
  readonly attemptNo: number;
  readonly maxAttempts: number;
}

/**
 * THE CURRENT RUN, AND IT IS NESTED BECAUSE THE WIRE NESTS IT.
 *
 * `null` means the supervisor names no run — which arm 8 reads as STUCK when a
 * ticket is claimed, so the nesting is load-bearing rather than cosmetic.
 *
 * `quietForMs` IS MILLISECONDS AND LIVES HERE, not seconds at the top level.
 * The first mirror put `quietForSeconds` beside `desired`; the wire has never
 * sent it, so the one number that separates a working seat from a dead one read
 * `absent` on every poll. `null` is NOT zero and NOT "fine": it means the clock
 * had nothing to read, which the classifier refuses to call `running`.
 */
export interface SupervisorRun {
  readonly runId: string;
  readonly phase: RunPhase | null;
  readonly status: RunStatus;
  readonly quietForMs: number | null;
}

/** The stable fingerprint — site plus sorted field paths, never prose. */
export interface SupervisorDefect {
  readonly signature: string;
  readonly failureClass: string;
  readonly bakeoffCode: string | null;
  readonly at: string;
  /** May an automated agent propose a repair for this class. Nothing gates on it yet. */
  readonly repairable: boolean;
}

/**
 * The last patch this installation applied to itself, or `null` when there has
 * been none.
 *
 * NULLABLE, AND WITH NO `summary` — WHICH MOVED A SENTENCE'S OWNER (2026-08-10).
 * The first mirror declared this non-nullable and gave it `summary` and
 * `signature`, arguing that the route should own the sentence so that two
 * components could not invent two versions of it. The route does not own it: the
 * wire is `{patchId, filesChanged, appliedAt, rerunPassed} | null` and
 * `composeSupervisorState` sends a literal `null` today. So the sentence is
 * composed in ONE place on this side — `repairSummary()` in `lib/supervisor.ts`,
 * which is tested — rather than in the component that renders it.
 */
export interface SupervisorRepair {
  readonly patchId: string;
  readonly filesChanged: readonly string[];
  readonly appliedAt: string;
  /** Null = the confirming re-run has not finished. NOT the same as false. */
  readonly rerunPassed: boolean | null;
}

/**
 * THE ROUTE'S OWN ARM CHECK, ON THE WIRE — and the client is required to render
 * it rather than to trust it.
 *
 * `wired: false` means there is no supervisor behind the route and every other
 * field is a default. `armed: false` means the route could not tell its own
 * outputs apart, i.e. the thing that composes this body is stuck. Neither may
 * be read as "running": a status panel that cannot distinguish a healthy
 * stopped system from a blind one is this repository's signature defect.
 */
export interface SupervisorProbe {
  readonly ticketsSeen: number;
  readonly runsSeen: number;
  readonly eventsSeen: number;
  readonly wired: boolean;
  readonly armed: boolean;
  readonly armNote: string;
  /**
   * THE WIRE FIELDS THIS BUILD HAS NO PRODUCER FOR, NAMED BY THE SERVER.
   *
   * `["attempts","lastDefect","lastRepair"]` today. THE CLIENT READS THIS RATHER
   * THAN HARDCODING THE SAME LIST: the strip used to carry a constant
   * `ATTEMPTS_NOT_ON_THE_WIRE = []` and would have gone on printing "the
   * supervisor does not report the authoring trail yet" for as long as nobody
   * edited the component — including the day a producer landed, which is the
   * inverse blindness and just as expensive.
   */
  readonly unsourced: readonly string[];
}

export interface SupervisorState {
  readonly desired: SupervisorDesired;
  /** When `desired` last changed. `supervisor_state.changed_at`, never blank. */
  readonly changedAt: string;
  /** owner|boot|guard. */
  readonly changedBy: string;
  /** Never blank by contract; the route substitutes if it is. */
  readonly reason: string;
  /**
   * THE SERVER'S OWN CLOCK AT THE INSTANT IT ANSWERED.
   *
   * DECLARED AND RENDERED, NOT YET USED FOR FRESHNESS — stated plainly because
   * the omission is deliberate and reversible. `classifySupervisor` ages the
   * reading against the CLIENT's receipt time, which catches the case that
   * actually happens (a suspended tab or a dead interval still painting a green
   * bar) and cannot catch a server answering instantly with an hour-old
   * computation. Ageing against this field instead would catch the second and
   * introduce clock-skew between two machines' `Date.now()` as a new way to paint
   * a false alarm. Carried forward rather than changed in a repair pass.
   */
  readonly at: string;
  readonly ticket: SupervisorTicket | null;
  readonly run: SupervisorRun | null;
  /**
   * THE AUTHORING TRAIL. On the wire, and EMPTY in this build — `probe.unsourced`
   * names it, which is what lets an empty list read as *nobody writes one yet*
   * rather than as *nothing happened*. That distinction is the whole reason run
   * a913c871's three rejections were invisible.
   */
  readonly attempts: readonly SupervisorAttemptView[];
  readonly lastDefect: SupervisorDefect | null;
  /** `supervisor_tickets.last_defect_id` — durable today where the full defect is not. */
  readonly lastDefectId: string | null;
  readonly lastRepair: SupervisorRepair | null;
  /** `supervisor_tickets.patch_id` — durable today where the full repair is not. */
  readonly lastPatchId: string | null;
  /**
   * THE LAST REPAIR CYCLE'S DECISION — SEPARATE FROM `lastRepair`, AND IT HAS TO
   * BE.
   *
   * `lastRepair` is `null` whenever no patch was applied, and three of
   * `decideRepairOutcome`'s four arms apply nothing while still constituting a
   * complete, correct, ledger-written repair cycle. So a cycle cannot be reported
   * as a member of `lastRepair`: the field it would hang off is null in exactly
   * the cases that need reporting. See {@link SupervisorRepairCycle}.
   *
   * `?: T | null` because no producer sends it (`grep -rn lastRepairCycle
   * dashboard/server/src` → 0 on 2026-08-10). Absent, `null` and a value are
   * three different sentences in the panel.
   */
  readonly lastRepairCycle?: SupervisorRepairCycle | null;
  /** Never blank. */
  readonly nextAction: string;
  readonly nextActionAt: string | null;
  /**
   * TWO NUMBERS BECAUSE THEY ARE TWO QUESTIONS. `queueDepth` is the supervisor's
   * own backlog (`supervisor_tickets` in state `queued`); `queuedRuns` counts
   * `runs.status='queued'`, which includes anything the owner submitted from the
   * page. STOP does not touch the second one, so a strip that added them together
   * would report a drained supervisor as busy.
   */
  readonly queueDepth: number;
  readonly queuedRuns: number;
  readonly probe: SupervisorProbe;
}

/**
 * `POST /api/supervisor/start` | `/stop` | `/abort-now`.
 *
 * THE WHOLE STATE PLUS TWO FIELDS, WHICH IS WHAT THE SERVER ACTUALLY SENDS
 * (`ApiSupervisorCommandResponse extends ApiSupervisorState`). The first mirror
 * declared `{desired, changed, inFlightRunId, note}`; `inFlightRunId` has never
 * been on the wire. Nothing dereferenced it — the strip reads `note` — so it
 * crashed nothing and was drift all the same.
 */
export interface SupervisorCommandResponse extends SupervisorState {
  /** False when the command was a no-op — starting a running supervisor. */
  readonly changed: boolean;
  /** Never blank: what the command did, in one sentence. */
  readonly note: string;
}

/**
 * ONE AUTHORING ATTEMPT AND WHAT THE AUDIT SAID ABOUT IT.
 *
 * ON THE WIRE AS A FIELD, EMPTY AS A VALUE, AND THE DIFFERENCE MATTERS.
 * `SupervisorState.attempts` is sent on every poll and `probe.unsourced` names
 * `attempts` as a field with no producer in this build, so the strip can say WHY
 * the list is empty instead of rendering an empty box that looks like a converged
 * run. The day a producer lands, the name leaves `unsourced`, the strip renders
 * the trail, and nothing in this file or the component changes.
 *
 * The comparison this shape exists for is the one a913c871 needed and never got:
 * `id` -> `kind` -> `id`, three attempts, a budget of three never exceeded, 87
 * minutes reading as WORKING. The comparator is built, armed and tested
 * (`lib/supervisor.ts` `attemptProgress`, and both directions in
 * `tests/supervisor-strip.unit.spec.ts`).
 */
export interface SupervisorAttemptView {
  readonly n: number;
  readonly at: string;
  readonly problems: readonly string[];
}

/* ------------------------------------------------------------------ */
/* THE TICKET CENSUS — `GET /api/supervisor/tickets`                    */
/* ------------------------------------------------------------------ */

/**
 * WHY THIS ROUTE HAS TO EXIST, IN ONE MEASUREMENT.
 *
 * `GET /api/supervisor` sends `ticket` (the ONE claimed ticket, or null) and
 * `queueDepth`, which `http.ts:1256` computes as
 * `tickets.filter((t) => t.state === "queued").length`. So when the loop has
 * finished the night's work, both routes agree: nothing is claimed, nothing is
 * queued. THE STRIP RENDERS `IDLE / idle, queue empty` — and it renders the
 * BYTE-IDENTICAL row when every ticket ended `blocked`. The owner comes back
 * after eight hours to a sentence that cannot tell "it worked" from "it all
 * died", which is a confident statement the page has no data for: the same class
 * as the preview card that announced a healthy backend was down.
 *
 * The distinction is not derivable from `SupervisorState`. `done`, `blocked` and
 * `abandoned` are all "not queued and not claimed", and no field on that body
 * counts them. It needs the rows, so it needs a second route.
 *
 * ─── THIS MIRROR IS WRITTEN AGAINST A ROUTE THAT DOES NOT EXIST YET ───
 *
 * Measured 2026-08-10: `grep -rn "supervisor/tickets" dashboard/server/src`
 * finds only `POST /api/supervisor/tickets` (filing) — there is no GET. The
 * producer is another lane's work, so the ONLY honest way to declare this is a
 * shape whose absence is a legible state rather than a crash or an invention.
 * Hence three rules that the rest of the supervisor block does not follow:
 *
 *   1. `tickets` IS THE ONLY REQUIRED FIELD, because it is the only one this
 *      readout cannot substitute for. A body without it is not a census.
 *   2. A ROW REQUIRES `ticketKey` AND `state` AND NOTHING ELSE. Those two are
 *      what the count is computed from; every other column of
 *      `supervisor_tickets` is declared `?: T | null` — see rule 3.
 *   3. `?: T | null` IS DELIBERATE AND IS THE ONE PLACE THIS FILE BREAKS ITS OWN
 *      "`T | null`, NEVER `T?`" RULE. That rule exists so that "the supervisor
 *      says there is no run" cannot collapse into "the field is missing", and it
 *      is right for a field the server ALWAYS sends. These fields have no server
 *      at all yet, so there are THREE states, not two: the key is missing (this
 *      build's route does not carry the column), the key is present and `null`
 *      (the column is NULL for this ticket), or a value. `validateCensus` in
 *      `lib/supervisor.ts` distinguishes all three and publishes the missing keys
 *      in `absentFields`, which the panel renders as "this build does not report
 *      X" — never as `null`, and never as a zero count.
 *
 * WHY NOT REQUIRE THE LOT AND LET IT GO AMBER UNTIL THE PRODUCER LANDS. Because
 * that is the failure recorded at the top of this block: a mirror that disagreed
 * with the wire in fifteen fields painted amber `MALFORMED` on every route, and
 * "nothing crashed, and nothing was readable either". A census route that lands
 * carrying eight of twelve columns must produce a WORKING count with four named
 * gaps, not a blank strip.
 */
export interface SupervisorTicketRow {
  /** `supervisor_tickets.ticket_key`. The primary key; never null. */
  readonly ticketKey: string;
  /**
   * `supervisor_tickets.state` — one of
   * `queued|claimed|running|repairing|waiting|blocked|done|abandoned`.
   *
   * TYPED `string`, NOT THE UNION, for the same reason `SupervisorTicket.state`
   * is: the server types its own as `string` so that a ninth state does not turn
   * a valid body into a client type error. `censusCounts` in `lib/supervisor.ts`
   * buckets the eight it knows and counts anything else as `unrecognised`, which
   * is reported rather than silently dropped into "done".
   */
  readonly state: string;
  readonly title?: string | null;
  /** `supervisor_tickets.model_id`. */
  readonly modelId?: string | null;
  readonly attemptNo?: number | null;
  readonly maxAttempts?: number | null;
  /**
   * `supervisor_tickets.next_action` — THE ONE STRING THAT TELLS THE OWNER WHAT
   * TO RUN BY HAND, and today it exists only in the database.
   *
   * NOT THE SAME FIELD AS `SupervisorState.nextAction`. That one is the
   * SUPERVISOR's next action, composed per poll by `composeSupervisorState`, and
   * the strip has rendered it since the first version. This one is the column on
   * the blocked ticket's own row (`db.ts:889`, `TEXT NOT NULL` with no default —
   * its schema comment calls that "THE ANTI-SIGNATURE-DEFECT" choice, because a
   * ticket that cannot say what to do next is a dead end filed as a record). A
   * blocked ticket carries `NO_REPAIR_DRIVER` plus a sentence, and until this
   * route exists no screen in the app can show it.
   */
  readonly nextAction?: string | null;
  readonly nextActionAt?: string | null;
  readonly enqueuedAt?: string | null;
  readonly updatedAt?: string | null;
  /**
   * THE RUN THIS TICKET IS ON, OR THE LAST ONE IT HAD — one field, because the
   * reader's question is "which run do I open".
   *
   * MIRRORED FROM `ApiSupervisorTicketRow`, WHICH REPLACED THIS MIRROR'S FIRST
   * GUESS. The first version of this file declared `lastRunId`; the wire that
   * landed sends `runId` and `currentRunId`, and `lastRunId` has never been on it.
   * Nothing dereferenced the wrong name, so it crashed nothing and was drift all
   * the same — the exact shape of the fifteen-field failure recorded at the top of
   * this block, caught this time because the mirror was reconciled against the
   * server's declaration rather than against the design note.
   */
  readonly runId?: string | null;
  /** Null once the run settles. Kept apart from `runId` so "running now" is decidable. */
  readonly currentRunId?: string | null;
  /** `last_class` — the failure class the classifier settled on. */
  readonly lastClass?: string | null;
  /** `last_defect_id` — durable today where the full defect record is not. */
  readonly lastDefectId?: string | null;
  /** `patch_id` — set when a repair was applied for this ticket. */
  readonly patchId?: string | null;
  readonly attachments?: SupervisorTicketAttachments | null;
}

/**
 * WHAT ONE TICKET FILED AND WHETHER ITS RUN ACTUALLY GOT IT — mirrored from
 * `ApiTicketAttachments`.
 *
 * `carriedIntoRun` IS THREE-VALUED AND THE THREE VALUES ARE NOT NEGOTIABLE:
 * `null` means there was nothing to carry (or no run yet), `false` means the
 * ticket's digests are NOT all in the run's manifest — the attachments were
 * DROPPED — and `true` means every one arrived. A two-valued field would read
 * `false` for every attachment-free ticket, which is noise on the one field that
 * answers the question. This readout does not render it yet; it is declared and
 * validated so that a body carrying it cannot make a consumer throw the day
 * something does.
 */
export interface SupervisorTicketAttachments {
  readonly manifest?: string | null;
  readonly images?: number | null;
  readonly documents?: number | null;
  readonly capture?: boolean | null;
  readonly motion?: boolean | null;
  readonly carriedIntoRun?: boolean | null;
}

/**
 * THE CENSUS ROUTE'S OWN ARM CHECK — mirrored from `ApiSupervisorTicketsProbe`.
 *
 * OPTIONAL, WHICH IS ITSELF A REPORTED STATE. When the key is absent the panel
 * says the census route reports no arm check; it does NOT say the check passed,
 * and it does not invent `armed: true`. The route that landed always sends one,
 * so absence here now means DRIFT rather than an early version — and the panel
 * printing "reports no arm check of its own" over a route that ships one is
 * exactly the visible failure to want.
 *
 * THERE IS NO `wired` AND NO `unsourced`. The first version of this mirror had
 * both, copied from `SupervisorProbe`, and the wire carries neither. They are
 * removed rather than left optional: a field nothing sends is drift whether or not
 * anything dereferences it.
 */
export interface SupervisorCensusProbe {
  readonly ticketsSeen?: number | null;
  /** Tickets whose `references.json` exists and would not parse. */
  readonly manifestsUnreadable?: number | null;
  /** Tickets whose attachments did NOT reach their run — `carriedIntoRun: false`. */
  readonly attachmentsDropped?: number | null;
  readonly armed?: boolean | null;
  readonly armNote?: string | null;
  /** The server's own clock, so a frozen tab cannot render as a live reading. */
  readonly at?: string | null;
}

/**
 * `GET /api/supervisor/tickets`. Oldest first — `enqueued_at ASC`.
 *
 * THE CLOCK IS `probe.at` AND THERE IS NO TOP-LEVEL `at`. The first version of
 * this mirror declared one; `ApiSupervisorTicketsResponse` has exactly two keys.
 */
export interface SupervisorTicketCensus {
  /**
   * EVERY TICKET ROW, TERMINAL ONES INCLUDED — which is the whole point.
   *
   * A route that returned only the OPEN tickets would answer `[]` for both of the
   * states this census exists to tell apart. If a producer ever paginates it, the
   * page that omits terminal rows is not a census and the count it yields is a
   * lie with a number on it.
   */
  readonly tickets: readonly SupervisorTicketRow[];
  readonly probe?: SupervisorCensusProbe | null;
}

/* ------------------------------------------------------------------ */
/* THE REPAIR CYCLE'S OWN FIELDS — additive, absent in this build      */
/* ------------------------------------------------------------------ */

/**
 * WHAT A REPAIR CYCLE ACTUALLY DECIDED, ON THE WIRE, WHEN SOMETHING WIRES IT.
 *
 * `SupervisorRepair` above carries `{patchId, filesChanged, appliedAt,
 * rerunPassed}` — four fields that all presuppose A PATCH WAS APPLIED. Measured
 * 2026-08-10, that presupposition is false for every outcome this repository can
 * currently produce: `tools/repair/supervisor-cycle.mjs`'s `decideRepairOutcome`
 * returns `NO_PATCH_AUTHOR` (design §5.3 records that the patch author is
 * deliberately not built), `NO_SANDBOX` (the prover refuses the working tree) or
 * `ALREADY_RULED_OUT` (the ledger has seen this proposal fail) — and exactly one
 * of its four arms, `applied`, produces a patch id.
 *
 * So a panel that renders `lastRepair === null ? "no patch has been applied"`
 * reads IDENTICALLY for "no repair was ever attempted" and "a repair ran, was
 * REFUSED on sight because the ledger already ruled that proposal out, and wrote
 * a row saying so". The second is the loop working correctly. Reporting it as
 * nothing is the absence-as-success defect at the one place the owner would look
 * to find out whether the machine can fix itself.
 *
 * EVERY FIELD HERE IS `?: T | null`, and the reason is rule 3 of the census
 * block: none of them is on the wire in this build (`composeSupervisorState`
 * sends `lastRepair: null` and `probe.unsourced` names `lastRepair`). Requiring
 * them would turn today's real body malformed — the fifteen-field amber again.
 * `repairCycleSummary` in `lib/supervisor.ts` composes the sentence and names the
 * fields that were missing, so a half-landed producer reads as a half-landed
 * producer.
 *
 * THE NAMES ARE TAKEN FROM THE PRODUCER, NOT INVENTED HERE. `verdict` is
 * `cycle.mjs`'s ledger verdict (`ACCEPTED` | `REFUSED` | `COULD_NOT_REPRODUCE` |
 * `NO_PATCH_AUTHOR`); `outcomeKind` and `outcomeCode` are `decideRepairOutcome`'s
 * `kind` and `code`. If the producer lands with different spellings, this mirror
 * is wrong and the panel will say the fields are absent — which is the failure
 * mode to want, because it is visible.
 */
export interface SupervisorRepairCycle {
  /** The defect signature this cycle was addressed to. */
  readonly signature?: string | null;
  /** `applied` | `refused` | `inconclusive` — `decideRepairOutcome().kind`. */
  readonly outcomeKind?: string | null;
  /** `NO_PATCH_AUTHOR` | `NO_SANDBOX` | `ALREADY_RULED_OUT` | … */
  readonly outcomeCode?: string | null;
  /** The ledger verdict the row was written under, or null when no row was written. */
  readonly verdict?: string | null;
  /** The proposal's content fingerprint, or null when there was no proposal. */
  readonly fingerprint?: string | null;
  /**
   * WAS THE TREE CHANGED. `false` IS NOT `null` AND NEITHER IS ABSENT.
   *
   * `false` means the cycle ran and applied nothing — the honest answer for three
   * of the four arms. `null` means the producer sent the field and does not know.
   * Absent means nothing reports it, and the panel must not print either of the
   * other two over that.
   */
  readonly applied?: boolean | null;
  /**
   * WHAT TO RESTORE TO IF THE PATCH HAS TO COME OUT — a commit sha, a stash ref,
   * or a path to the saved copy.
   *
   * THE FIELD THE OWNER NEEDS AND THE ONE MOST LIKELY TO BE MISSING. An applied
   * patch with no rollback point is not a repair, it is an edit; the panel prints
   * that judgement in those words rather than leaving the cell blank, because a
   * blank cell reads as "fine".
   */
  readonly rollbackPoint?: string | null;
  /** The cycle's own sentence, if the producer composes one. */
  readonly detail?: string | null;
  readonly at?: string | null;
}
