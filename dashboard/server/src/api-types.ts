/**
 * api-types.ts — THE FROZEN HTTP CONTRACT.
 *
 * The UI builds against exactly these shapes. Nothing here may be widened,
 * narrowed or renamed without changing the UI in the same commit.
 *
 * ONE FIELD IS LOAD-BEARING AND EASY TO GET WRONG: `costUsd`.
 *
 * Dashboard runs are driven by SUBSCRIPTION-authenticated subprocess SDKs
 * (`claude setup-token`, `codex login`). A subscription consumes QUOTA; it is
 * not billed per token. There is therefore no dollar figure for a dashboard
 * run, and `costUsd` is `null` for every one of them. The Claude Agent SDK does
 * report `total_cost_usd` on its result message — that number is what the same
 * traffic WOULD have cost at API list price, not what the owner is charged, and
 * it is dropped at the SDK boundary (see builders/claude-builder.ts). Rendering
 * it would invent a bill that does not exist.
 *
 * What replaces it: token counts, which are real and are reported, and
 * rate-limit state, which is the constraint that actually binds.
 */

/**
 * Providers the DASHBOARD knows about — deliberately NARROWER than `Provider` in
 * `bakeoff/src/contracts.ts`, which keeps all four.
 *
 * `"moonshot" | "deepseek"` were removed on 2026-07-30 when the owner removed the
 * Kimi and DeepSeek rows ("we only use Claude"). This is not a mirror any more
 * and must not be re-widened to match: the bake-off harness really does drive
 * those two vendors over its budget proxy, and this package really does not — it
 * holds no API key and spawns only subscription CLIs. `db.ts`'s `PROVIDERS` guard
 * is the same list; a value outside it now throws on the way out of the store
 * rather than being silently accepted.
 *
 * `"openai"` stays even though no run may select it: the Codex row is still
 * resolvable (see `models.ts`) and `db.ts` may hold rows written before the
 * 2026-07-28 scope decision.
 */
export type ApiProvider = "anthropic" | "openai";

/**
 * `included` — covered by a subscription the owner already pays for.
 * `metered`  — billed per token against an API key.
 *
 * NO ROW SERVED BY `/api/models` CARRIES `metered` ANY MORE (2026-07-30, see
 * `models.ts`). The member stays because it describes a RUN's billing rather than
 * a catalog row: `src/lib/cost.ts` reads it to decide whether a run can have a
 * dollar cost at all, and deleting it would delete that distinction for any run
 * whose model is no longer in the list.
 */
export type ModelTier = "included" | "metered";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly provider: ApiProvider;
  readonly tier: ModelTier;
  /** False => the UI renders the option disabled and shows `reason`. */
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * Run lifecycle.
 *
 * `rate_limited` is NOT an error state. Both subscription providers enforce a
 * 5-hour rolling window plus a weekly cap; hitting one is an expected outcome
 * of a long build. The run is persisted, the session id is kept, and
 * `POST /api/runs/:id/resume` continues it.
 *
 * NOTHING RESUMES IT FOR YOU UNLESS THE HOST OPTED IN. The server's auto-resume
 * (`DASHBOARD_RATE_LIMIT_AUTO_RESUME`, off by default) arms a timer only when
 * the provider reported a reset instant with the refusal; with it off, or with
 * no reported instant, the run waits for a human indefinitely. THAT DISTINCTION
 * IS NOT ON THE WIRE — no field here says whether a timer is armed — so a client
 * must not render a countdown or promise an automatic restart from the status
 * alone. The run's own log carries the sentence that decided it, either way.
 *
 * `awaiting_input` exists because doc 02 section 3d names
 * `PAUSED-AWAITING-HUMAN` as a first-class orchestrator state.
 */
export type ApiRunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "rate_limited"
  | "passed"
  | "failed"
  | "cancelled";

/**
 * `plan` IS FIRST AND IT IS FIRST FOR ONE REASON: a question asked after the
 * suite is frozen cannot change what the run is graded against, so it would be
 * theatre. Asked before, the answers enter the brief, the criteria are authored
 * from them, and `heldOutPass` keeps meaning exactly what it means today.
 *
 * EVERY RUN ALREADY ON DISK PREDATES IT. Nothing migrates: `db.ts`'s `PHASES` is
 * read through a membership test, so an old row saying `spec` still reads. What
 * DOES move is the client's `PHASE_ORDER` index — see the note there.
 */
export type ApiPhase = "plan" | "spec" | "build" | "gate" | "judge" | "done";

export type ApiCriterionResult = "pass" | "fail" | "pending";

/** Mirrors `CriterionTier` in contracts.ts. QUALITY is reported, never gating. */
export type ApiCriterionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";

export interface ApiCriterion {
  readonly id: string;
  readonly statement: string;
  readonly tier: ApiCriterionTier;
  readonly result: ApiCriterionResult;
}

export interface ApiTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/* -------------------------------------------------------------------------
 * SPEND, ATTRIBUTED BY SEAT — the 16.8% problem
 *
 * MEASURED ON THE LIVE END-TO-END RUN. One ticket's OUTPUT tokens were
 *
 *     spec 416,111 · audit 17,603 · judge 3,228 · builder 88,529
 *
 * and the only figure the owner was shown was 88,529 — the BUILDER's, which is
 * 16.8% of the 525,471 that ticket actually spent. The other four hundred
 * thousand were written to the run's log stream (orchestrator.ts:679, :680,
 * :1643, :1952) and accumulated nowhere at all.
 *
 * `RunDetail.tokens` IS NOT WRONG, AND THAT IS WHY THIS IS A SEPARATE SHAPE
 * RATHER THAN A FIX TO THAT FIELD. It is the builder's row, in the builder's
 * vendor, and tokens.ts's header says so at length. It is simply not the run's
 * spend, and it was the only number on offer. The seat rows below are the run's
 * spend; that field stays exactly what it claims to be.
 *
 * NO DOLLAR FIGURE APPEARS ANYWHERE IN HERE. See this file's header on `costUsd`
 * — the rule is not "we have not priced it yet", it is that a subscription seat
 * HAS no per-token price, and {@link ApiRunSpend.pricing} states that in a field
 * so that a reader cannot arrive at "$0.00" instead.
 * ---------------------------------------------------------------------- */

/**
 * Which SEAT spent it.
 *
 * FIVE NAMES, AND DELIBERATELY NOT `SeatRole`'s FOUR. contracts.ts declares
 * `SeatRole = "orchestrator" | "subagent" | "spec" | "judge"`, and it cannot be
 * this vocabulary: it has no name for the GATE/FIX rounds, its
 * orchestrator/subagent split is a bake-off variable rather than a dashboard one
 * — and, the case that actually breaks, THE DASHBOARD RUNS ONE SEAT CONSTANT FOR
 * TWO JOBS. `JUDGE_SEAT` is the AUDIT at orchestrator.ts:680 (the adversarial
 * bad-test pass over the frozen suite, before a line is built) and the JUDGE at
 * orchestrator.ts:1952 (the code-reading pass after the gate). Keyed by seat
 * CONSTANT those two collapse into one row, and 17,603 + 3,228 becomes a single
 * 20,831 belonging to neither job. Keyed by ROLE, as here, they stay apart.
 *
 * THERE IS NO `design` MEMBER, ON PURPOSE. The DESIGN segment is a
 * `builder.build()` call against the builder's own session (build-segment.ts),
 * so its tokens ARE the builder's and a separate seat would double-count them.
 * What the design lane spends of its own is metered image and video, which is
 * counted in {@link ApiMeteredSpend} — in calls and seconds, never tokens.
 */
export type ApiSpendSeat = "spec" | "audit" | "builder" | "fix" | "judge";

/**
 * The pricing basis of a dashboard run. ONE MEMBER, AND IT IS NOT A NUMBER.
 *
 * A LITERAL RATHER THAN A NULL, BECAUSE NULL IS WHAT WAS ALREADY THERE AND WAS
 * ALREADY MISREAD. `costUsd: null` is the system-wide invariant and it stays
 * (see this file's header), but `null` and `0` are both READ as "nothing was
 * spent" by a tired owner at the end of a long build — and `run.json` carries a
 * literal `totalCostUsd: 0` next to it. This field cannot be read that way: it
 * does not say "zero", it says WHY there is no number.
 */
export type ApiPricingBasis = "not-priced-subscription-seat";

/** One seat's token spend. Never a dollar figure. */
export interface ApiSeatSpend {
  readonly seat: ApiSpendSeat;
  readonly provider: ApiProvider;
  /**
   * The model this seat was CONFIGURED with, verbatim.
   *
   * NOT A CLAIM THAT ONE MODEL DID THE WORK. Delegation is the architecture: a
   * haiku orchestrator hands work to opus subagents, and tokens.ts's
   * {@link ModelTokens} rows carry that split for the log line. This row carries
   * the seat's TOTAL, which is the quantity that must never come out smaller
   * than what was spent — a per-model breakdown persisted here instead would
   * lose whatever remainder no model claimed (`unattributedTokens`), and the
   * total is the whole point of this record.
   */
  readonly modelId: string;
  readonly tokens: ApiTokens;
  /** Model calls (or turns) folded into this row. */
  readonly callCount: number;
}

/**
 * One VENDOR's total, and the reason `ApiRunSpend` has no single scalar.
 *
 * TOKEN COUNTS ARE PER VENDOR AND ARE NEVER SUMMED ACROSS VENDORS — tokenizers
 * differ, and `TOKEN_ACCOUNTING_RULE` in contracts.ts is the rule this obeys. On
 * a Codex run the builder is OpenAI while spec, audit and judge are Anthropic,
 * so "the run's tokens" is TWO numbers and reporting one would be a quantity
 * nobody measured. `seats` names what was folded in, so a reader can see at a
 * glance that the builder is one seat of four rather than the whole run.
 */
export interface ApiVendorSpend {
  readonly provider: ApiProvider;
  readonly tokens: ApiTokens;
  readonly callCount: number;
  /** The seats folded into this row, in the order the run acquired them. */
  readonly seats: readonly ApiSpendSeat[];
}

/**
 * Spend billed by the CALL or by the SECOND against a metered key.
 *
 * IT CARRIES NO `provider`, AND THAT IS NOT AN OMISSION. `ApiProvider` names the
 * four vendors the dashboard can BUILD with; the design lane's image and video
 * calls go to Gemini and Veo through a key read from `~/.gemini/api_key`, which
 * is not one of them. Widening `ApiProvider` for a row that has no tokens would
 * add a fifth member to every provider guard in db.ts and models.ts and to the
 * client's mirror of it. `model` is the vendor's own key for the model, verbatim
 * (`DESIGN_IMAGE_MODEL` in design-outcome.ts, or the Veo model in
 * video-legs.ts).
 */
export interface ApiMeteredSpend {
  readonly kind: "image" | "video";
  readonly model: string;
  /** Calls ATTEMPTED, retries included. A COUNT, never money. */
  readonly calls: number;
  /**
   * Seconds DELIVERED — A FLOOR ON WHAT WAS BILLED, AND THE NAME SAYS SO.
   *
   * `video-legs.ts:220` had to explain at length that its own `meteredSeconds`
   * counts `produced × durationSeconds`: a leg that was generated and billed and
   * then failed its download lands as ZERO. Carrying that number here under a
   * name like `seconds` would reproduce the same defect one layer out, where
   * there is no docblock next to the reader.
   *
   * `null` WHEN THE UNIT IS NOT TIME — an image call is billed per call — and
   * null is not 0. Zero seconds is a measurement; "this is not a duration" is
   * not.
   */
  readonly deliveredSecondsFloor: number | null;
}

/**
 * EVERYTHING ONE RUN SPENT, and the field that stops it reading as free.
 *
 * `bySeat` is the record, `byVendor` is the total (one row per vendor — see
 * {@link ApiVendorSpend}), `metered` is the spend that has no tokens at all, and
 * `pricing` is why none of it is a dollar figure. An EMPTY `bySeat` means NOTHING
 * WAS RECORDED, never "this run spent nothing": a run cancelled out of the queue
 * spent nothing and also recorded nothing, and the two are told apart by the rest
 * of the run row, not by pretending an empty list is a measurement of zero.
 */
export interface ApiRunSpend {
  readonly bySeat: readonly ApiSeatSpend[];
  readonly byVendor: readonly ApiVendorSpend[];
  readonly metered: readonly ApiMeteredSpend[];
  readonly pricing: ApiPricingBasis;
}

export interface ApiRateLimit {
  readonly limited: boolean;
  readonly retryAfterSec: number | null;
}

/**
 * HOW LONG THIS RUN HAS BEEN QUIET. NOT A DIAGNOSIS, AND THE NAMES SAY SO.
 *
 * THE FAILURE IT EXISTS FOR, MEASURED ON THIS MACHINE. Run
 * `run-2026-07-30T20-16-40-242Z-052c6e02` shows a 506.6-MINUTE gap between event
 * seq 328 and seq 329 in the `events` table — eight and a half hours in which
 * the row said `running`, the subprocess was idle, and nothing anywhere told the
 * owner. The dashboard could not distinguish that from a working build, because
 * nothing measured the gap.
 *
 * EVERY FIELD IS AN OBSERVATION AND NONE IS A VERDICT. There is deliberately no
 * `dead`, no `hung` and no `stalled: boolean`: this program has no way to
 * establish any of them. A subprocess that is thinking, a subprocess that is
 * blocked on a network read and a subprocess that has crashed all produce the
 * same thing here — SILENCE — and doc 03 §7.8 records the reason that matters:
 * LHTB found 79% of unresolved runs time out WHILE STILL ACTIVELY MAKING
 * PROGRESS, and its explicit guidance is not to build "the agent seems stuck"
 * heuristics that terminate. Nothing kills a run on this field. It reports.
 *
 * `null` MEANS "NOT WATCHED", NEVER "HEALTHY". Only a `running` run is measured.
 * A `queued` run has not started; `awaiting_input` and `rate_limited` are parks
 * that are SUPPOSED to be quiet and carry their own timers (`#parkForDesignLock`,
 * `#armRateLimitResume`); a terminal run is finished. A UI that renders `null`
 * as a green tick is inventing a health check that was never performed.
 */
export interface ApiRunSilence {
  /**
   * The instant this silence is measured FROM.
   *
   * Read it together with {@link ApiRunSilence.sinceKind}: it is either the last
   * event on the run's stream or, when there is none, the run's own start.
   */
  readonly since: string;
  /**
   * WHICH instant `since` is — because reporting `startedAt` as though it were
   * an event would be a quiet lie about a run that has never emitted anything.
   * `run-start` is the state of a run whose first event has not landed yet, and
   * of a run whose event writes are failing.
   */
  readonly sinceKind: "last-event" | "run-start";
  /**
   * Whole minutes of silence, FLOORED, AS OF THE MOMENT THIS RESPONSE WAS
   * ASSEMBLED. It is a snapshot and it does not tick: a client that wants a live
   * counter must derive it from {@link ApiRunSilence.since}, which is an instant
   * and stays true.
   */
  readonly quietMin: number;
  /** The threshold in force for this server, in minutes. See `DEFAULT_SILENCE_WARN_MIN`. */
  readonly thresholdMin: number;
  /**
   * `quietMin >= thresholdMin`. The strongest sentence it supports is "nothing
   * has been heard for longer than this server expects to hear nothing" — which
   * is the whole claim, and is not "the run is stuck".
   */
  readonly overThreshold: boolean;
}

export interface ApiScreenshot {
  readonly path: string;
  readonly label: string;
  readonly capturedAt: string;
}

/**
 * ONE FILE THE OWNER ATTACHED TO A TICKET, addressed so a browser can open it.
 *
 * WHY IT IS NOT A PATH. `ReferenceImage.path` and `ReferenceDocument.path` are
 * absolute HOST paths, written for an agent that calls `Read`. Measured this
 * session: the ticket form renders an attached PNG and PDF as bare text chips
 * and `document.querySelectorAll('img')` returns zero elements, because there
 * was no address the page could put in a `src`. {@link ApiAttachment.url} is
 * that address — same origin, served by `GET /api/runs/:id/references/:file` and
 * `GET /api/runs/:id/documents/:file`.
 *
 * `mediaType` IS THE EXACT `Content-Type` THE ROUTE WILL SEND, header value and
 * all, including the `; charset=utf-8` a text document carries. Both come from
 * one derivation in `run-attachments.ts`, so a client that decides how to render
 * from this field cannot be told one thing and sent another.
 *
 * `file` IS NOT THE NAME THE OWNER PICKED, AND MUST NOT BE RENDERED AS IF IT
 * WERE. The intake takes base64 data URLs, which carry no filename, so
 * `Kamil_Borzecki_CV.pdf` is discarded by the browser before the request is
 * sent and the server only ever knows the ordinal name it minted
 * (`document-1.pdf`, `reference-2.png`). Showing the original name would need
 * the client to send it and the intake to record it — an additive change on
 * both sides that nothing here fakes.
 *
 * `path` IS KEPT because it is the value the manifest records and the value the
 * builder and the DESIGN lane are given in their prompts, so it is what a bug
 * report or a log line has to be matched against. It is not openable from a
 * page; `url` is.
 */
export interface ApiAttachment {
  /** The server-minted filename, and the last segment of {@link ApiAttachment.url}. */
  readonly file: string;
  /** Absolute host path. Builder-facing; a browser cannot open it. */
  readonly path: string;
  /** sha256 of the bytes. THIS is what entered the ticket id. */
  readonly sha256: string;
  /** Size as digested at intake, not as `stat`ed now. */
  readonly bytes: number;
  /** Byte for byte the `Content-Type` the route answers with. */
  readonly mediaType: string;
  /** Same-origin, no host. Put it straight in a `src` or an `href`. */
  readonly url: string;
}

/**
 * The DESIGN lane's lock (spec §17), as the UI needs it.
 *
 * `mockups` are `ApiScreenshot`s because that is what the run already stores
 * and what `GET /api/runs/:id/screenshots/:file` already serves — §17.1's "the
 * screenshots route already serves images by basename" is the whole reason no
 * new image route exists for this feature.
 *
 * `lockedBy` REPEATS A UNION THAT design-manifest.ts ALSO DECLARES, and that is
 * deliberate: this file imports nothing, because the frozen wire contract must
 * not drag domain modules into the client's mental model. The join between the
 * two spellings is a compile-time check in api.test.ts ("CONTRACT: the wire's
 * lockedBy union names exactly the domain's DesignLockedBy"), not an import.
 */
export interface ApiDesignLock {
  /** The run is parked RIGHT NOW waiting for a mockup to be chosen. */
  readonly awaiting: boolean;
  readonly mockups: readonly ApiScreenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
}

/**
 * ONE human-factors finding, as the pass reported it — spec §8, /debugfix §5.
 *
 * `severity` IS THE FOUR-MEMBER UNION, spelled out here rather than typed
 * `string`, and that is the opposite decision from `stop` below. The producer's
 * parser (`parseAdversaryFindings` in adversary.ts) DROPS any entry whose
 * severity is not one of these four, so the set is closed by the writer and a
 * fifth value cannot arrive on this field. `stop` has no such filter.
 *
 * `klass` IS `string` FOR THE `gateStopReason` REASON. Its vocabulary is
 * `FailureClass` in gate-report.ts (install, build, boot, route, visual,
 * test-infra, logic, structure); this file imports nothing, and repeating the
 * union here would be a second spelling needing its own compile-time join for a
 * value every renderer needs a default branch for anyway.
 *
 * `detail` IS `""`, NEVER ABSENT, and empty means "the pass handed back no
 * repro text". The collapse happened upstream, not here: `AdversaryFinding.detail`
 * is optional in the domain and `parseAdversaryFindings` already writes `""`
 * for a missing one, so nothing is lost at this boundary.
 */
export interface ApiAdversaryFinding {
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly klass: string;
  readonly summary: string;
  readonly detail: string;
}

/**
 * The human-factors adversary pass, as the run recorded it.
 *
 * THIS LANE HAS NEVER EXECUTED. Stated in those words because it is the most
 * important thing about this shape: `#adversaryPhase` needs a `previewUrl`,
 * which needs a scored run with `deploy` set, and no run on this machine has
 * reached it. Every field below is served from a record file whose PRODUCER HAS
 * NEVER RUN — the reader, the mapper and the mirror are tested, the writer is
 * not. A UI must not present these findings as a proven channel, and an absent
 * `adversary` on a finished web run is the EXPECTED state today, not a bug.
 *
 * THE TRUTH TABLE, AND THE WHOLE REASON `findings` IS NULLABLE:
 *
 *   `adversary: null`                  no record on disk. The run never reached
 *                                      phase 5, or it predates the lane.
 *   `ran: false`, `findings: null`     the pass was CONSIDERED AND DECLINED.
 *                                      `stop` says why (`not-applicable` for a
 *                                      run with no loopback preview, or one of
 *                                      the refusals).
 *   `ran: true`,  `findings: null`     it ran and LEFT NO REPORT. This is NOT
 *                                      "the pass found nothing" — the session
 *                                      writes its findings to a file, whether a
 *                                      live session complies is untested, and a
 *                                      missing file means this program cannot
 *                                      see what it found.
 *   `ran: true`,  `findings: []`       it ran, reported, and FOUND NOTHING.
 *
 * The last two are the pair this field exists to keep apart. Collapsing them
 * into an empty array is the defect this codebase keeps finding, and it is the
 * same refusal `heldOutPass: null` makes about a gate that did not run.
 *
 * WHAT IS DELIBERATELY NOT HERE. The record on disk also carries `notes`,
 * `previewUrl`, `environment`, `wallClockMs` and `agent`; none of them are on
 * the wire. The notes are four paragraphs about what the lane does not have
 * (no hook enforcement, no per-agent turn bound, no browser), written for the
 * morning-after reader of `adversary.json` rather than for a panel.
 *
 * NON-GATING, MECHANICALLY. `withAdversaryFindings` copies `heldOutUnmet`
 * unchanged and `#adversaryPhase` runs after the run is scored, so nothing here
 * can move `heldOutPass`, `status` or `failureReason`. A UI that rendered these
 * rows as failures would be inventing a second, unsealed grader.
 */
export interface ApiAdversaryPass {
  /** The session was actually spawned. False for every refusal. */
  readonly ran: boolean;
  /**
   * Why the lane stopped, or `ran` when it completed.
   *
   * A STRING, NOT A UNION, for `gateStopReason`'s reason: the vocabulary is
   * `AdversaryStop` in adversary.ts (`ran`, `not-applicable`, `agent-missing`,
   * `agent-denylist-drift`, `denylist-incomplete`, `workspace-not-isolated`,
   * `timeout`, `failed`, `cancelled`) and this file imports nothing. A renderer
   * needs a default branch either way; a reason this client has never heard of
   * is a newer server, not a bug.
   */
  readonly stop: string;
  /**
   * The lane's own sentence about why it stopped — EMPTY on a clean run.
   *
   * NAMED `stopDetail` AND NOT `detail` on purpose: {@link
   * ApiAdversaryFinding.detail} is a finding's repro text, and two different
   * facts under one key in a nested render is how a panel ends up showing a
   * refusal reason under a finding.
   *
   * TRUNCATED AT 2000 CHARACTERS by `adversaryPassFromRecord`. Reachable: a
   * `failed` stop carries whatever the session threw, which has no bound. The
   * untruncated text is in `results/adversary.json` and in the run's log stream.
   */
  readonly stopDetail: string;
  /** `null` = no report to read; `[]` = a report that found nothing. See above. */
  readonly findings: readonly ApiAdversaryFinding[] | null;
}

/**
 * Something in the workspace that was NOT copied into the published project,
 * and why.
 *
 * ON THE WIRE FOR `CodeExclusion`'s REASON, ONE LAYER OUT: a folder that
 * silently drops `visible-acceptance/` is indistinguishable from a copy that
 * failed halfway, and the owner cannot tell a filtered project from a broken
 * one. `path` is relative to the workspace root, forward slashes, no leading
 * slash — the same spelling {@link CodeTreeEntry.path} uses, so a reader can
 * take an entry from this list straight to `GET /api/runs/:id/files?path=`.
 *
 * A SEPARATE DECLARATION FROM {@link CodeExclusion}, WHICH IS STRUCTURALLY
 * IDENTICAL TODAY. They have different producers (`project-publish.ts` and
 * `code-files.ts`), different vocabularies of reason, and no shared consumer;
 * merging them would mean a rename made for the file viewer silently retypes
 * the publisher's record, which is written to disk and read back by a later
 * server.
 */
export interface ApiProjectExclusion {
  readonly path: string;
  readonly reason: string;
}

/**
 * WHERE THE FINISHED CODE WAS PUT, outside the run directory.
 *
 * THE PROBLEM IT SOLVES, IN THE OWNER'S WORDS: "the code will be saved into a
 * folder within this directory". Today the artefact is at
 * `dashboard/runs/run-2026-07-30T20-16-40-242Z-052c6e02/workspace/` — a
 * 37-character generated id inside a server package — and he reported he cannot
 * find it and that it does not read as his project. `project-publish.ts` COPIES
 * it to `projects/<slug-of-the-ticket-title>/` when the run goes terminal.
 *
 * (37, COUNTED off the very id quoted above, which this docblock called
 * "44-character" until 2026-08-02. It follows from `http.ts`, which mints the id
 * as `run-` + a 24-character ISO instant + `-` + 8 uuid characters = 37. NOTHING
 * TESTS THE MINTER: `publish-wiring.test.ts` asserts only that its own FIXTURE
 * is 37, so a change to the id format would leave that test green and this
 * sentence wrong. Three docblocks still say 44 and were left alone as out of
 * scope: `paths.ts`, `project-publish.ts`, `src/components/canvas/sheet.tsx`.)
 *
 * IT IS NOT {@link RunDetail.previewUrl} AND MUST NOT BE RENDERED AS ONE. That
 * field is a historical record of an address that was served by a process which
 * died with the run: measured on this machine, the one finished run recorded
 * `http://127.0.0.1:4321` and nothing has listened there since. This is a
 * FILESYSTEM PATH on the host — a browser cannot open it, exactly like
 * `artifactPath`, `verdictPath` and `screenshots[].path`.
 *
 * A THREE-STATE TRUTH TABLE, AND THE MIDDLE ROW IS THE POINT:
 *
 *   `publishedProject: null`   NO RECORD. The run has not reached a terminal
 *                              state, or it finished before this lane existed,
 *                              or the record file could not be read. Nothing was
 *                              attempted, as far as this server can tell.
 *   `published: false`         IT WAS ATTEMPTED AND DECLINED. `reason` names
 *                              which refusal (`workspace-missing`,
 *                              `workspace-empty`, `no-free-name`,
 *                              `copy-failed`) and `detail` is the sentence.
 *   `published: true`          The copy exists at `path`.
 *
 * Collapsing the first two into "no folder" is the defect this codebase keeps
 * finding — the same one {@link ApiAdversaryPass} refuses between "the pass left
 * no report" and "the pass found nothing".
 *
 * WHAT IT DOES NOT CLAIM. `published: true` says a copy was written at the
 * instant `publishedAt` names. It does NOT say the folder is still there (the
 * owner may have moved or deleted it — it is his), that the code runs, or that
 * it passed anything: `heldOutPass` is the only field that speaks to quality,
 * and a FAILED run publishes too, because a failed build's code is still the
 * thing he asked to be able to open.
 */
export type ApiPublishedProject =
  | {
      readonly published: true;
      /** Absolute HOST path of the copy, e.g. `…/coding-agent/projects/coglane-landing`. */
      readonly path: string;
      readonly publishedAt: string;
      /** Regular files copied. Directories are not counted. */
      readonly fileCount: number;
      /** Bytes copied, summed over those files. */
      readonly bytes: number;
      /** What was left behind, and why. Empty means nothing was filtered. */
      readonly excluded: readonly ApiProjectExclusion[];
    }
  | {
      readonly published: false;
      /**
       * Which refusal, as a STRING rather than a union — {@link
       * RunDetail.gateStopReason}'s reason. The vocabulary is `PublishDecline`
       * in `project-publish.ts`; this file imports nothing, a renderer needs a
       * default branch either way, and a reason a client has never heard of is a
       * newer server rather than a bug.
       */
      readonly reason: string;
      /** The refusal in a sentence, naming the path it looked at. */
      readonly detail: string;
      readonly attemptedAt: string;
    };

/* -------------------------------------------------------------------------
 * A published project, and the process serving it
 * ---------------------------------------------------------------------- */

/**
 * HOW A CHILD ENDED. Recorded whether the owner asked for it or not, because
 * the two are different facts and the UI must not draw them the same.
 *
 * `requested: true`  the owner pressed stop and this is the receipt.
 * `requested: false` it died on its own — a crash, a port collision inside the
 *                    project's own code, an `npm start` that exits immediately.
 *                    THAT is the case a green "stopped" chip would hide.
 */
export interface ApiProjectExit {
  readonly at: string;
  /** Null when a signal ended it; `signal` is then non-null. */
  readonly code: number | null;
  readonly signal: string | null;
  readonly requested: boolean;
}

/**
 * THREE STATES, AND THE THIRD IS THE POINT — the same rule
 * {@link ApiPublishedProject} follows.
 *
 * `stopped` nothing of ours is running. `lastExit` is null when this dashboard
 *           never started it, and non-null (with `requested: true`) when the
 *           owner stopped it.
 * `running` a child is alive AND the URL below answered an HTTP request at
 *           `readyAt`. It is never set on the strength of a successful spawn:
 *           see `project-runner.ts`, where readiness is measured.
 * `exited`  a child we started died WITHOUT being asked to. The port is
 *           released and the logs are still readable, which is the only reason
 *           this is not folded into `stopped`.
 *
 * WHAT `running` DOES NOT CLAIM: that the URL answers RIGHT NOW. It answered at
 * `readyAt` and the process was alive at the moment this response was built. A
 * server that wedged in between reads as running, and no amount of bookkeeping
 * here can say otherwise without probing on every list — which would put an
 * HTTP request per project on a route the UI polls.
 */
export type ApiProjectProcess =
  | { readonly state: "stopped"; readonly lastExit: ApiProjectExit | null }
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
      readonly exit: ApiProjectExit;
    };

/**
 * One folder under `projects/`, with everything needed to decide what to do
 * about it.
 *
 * `startCommand` IS NULL WHEN THE PROJECT CANNOT BE STARTED — no
 * `package.json`, or one with no `start` script. The UI must read it before
 * offering a start button, because the route's refusal for that case is a 409
 * the owner should never have to see.
 *
 * `runId` is the run that published this folder, discovered by reading each
 * run's own publish record. Null means no record names it — a folder the owner
 * created himself, or one published before the record existed. It is what
 * `POST /api/runs/:id/publish` is keyed on, so a null one cannot be
 * re-published from the projects list.
 */
export interface ApiProject {
  /** The directory name under `projects/`. The only id this API accepts. */
  readonly slug: string;
  /** Absolute HOST path. A browser cannot open it; see {@link ApiPublishedProject}. */
  readonly path: string;
  /** e.g. `npm start`. Null when nothing here can be started. */
  readonly startCommand: string | null;
  /** True when the folder has its own git repository (the handover's, or the owner's). */
  readonly hasRepository: boolean;
  readonly runId: string | null;
  readonly process: ApiProjectProcess;
}

export interface ApiProjectsResponse {
  readonly projects: readonly ApiProject[];
  /** The loopback port window children are allocated from, inclusive. */
  readonly portRange: { readonly min: number; readonly max: number };
}

/**
 * `started: false` with a `running` process is the ALREADY-RUNNING answer: the
 * existing URL, and no second child. It is a 200 rather than a refusal because
 * the caller asked for a running project and got one.
 */
export interface ApiProjectStartResponse {
  readonly started: boolean;
  readonly project: ApiProject;
}

export interface ApiProjectStopResponse {
  readonly stopped: boolean;
  readonly project: ApiProject;
}

export interface ApiProjectLogLine {
  readonly stream: "stdout" | "stderr";
  readonly at: string;
  readonly text: string;
}

/**
 * RECENT output, bounded and redacted at the source. `dropped` is how many
 * lines fell off the front — a chatty server's log is a window, not a
 * transcript, and a window that does not say what it lost is a lie about
 * volume.
 */
export interface ApiProjectLogs {
  readonly slug: string;
  readonly lines: readonly ApiProjectLogLine[];
  readonly dropped: number;
  readonly maxLines: number;
}

/**
 * What `POST /api/runs/:id/publish` did — the copy, and the four things that
 * make the copy workable.
 *
 * SERIALIZED BY THE ROUTE FROM THE SERVER RECORD, because
 * `publishedProjectFromRecord` deliberately forwards six fields and no more:
 * `RunDetail.publishedProject` is a summary of a run, while this is the
 * response to an action the owner just took and has to be able to read the
 * outcome of.
 *
 * A DECLINED publish is NOT this shape. It is the ordinary error envelope with
 * the decline's own reason as the code, because nothing was published.
 */
export interface ApiRepublishResponse {
  readonly runId: string;
  readonly path: string;
  readonly publishedAt: string;
  readonly fileCount: number;
  readonly bytes: number;
  /** `committed` | `unchanged` | `declined`. */
  readonly repository: string;
  /** The commit sha, or null when nothing was committed. */
  readonly commit: string | null;
  /** Non-null only when the repository step declined, and then it names why. */
  readonly repositoryDetail: string | null;
  /** `written` | `kept` | `declined`. */
  readonly readme: string;
  readonly gitignore: string;
  /** One entry per SQLite file found in the published copy. */
  readonly databases: readonly { readonly file: string; readonly schema: string | null }[];
  /**
   * The folder this run published to last time and did NOT write into, because
   * the owner has committed there since. Null in the ordinary case.
   */
  readonly redirectedFrom: string | null;
}

export interface RunSummary {
  readonly runId: string;
  readonly ticketTitle: string;
  readonly modelId: string;
  readonly status: ApiRunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /**
   * CO-PRIMARY METRIC 1, from `computeHeldOutPass` in contracts.ts.
   * `null` means NOT DETERMINED — the sealed gate did not run (no Docker, run
   * cancelled, build never produced an artefact). A gate that could not run
   * must never be indistinguishable from a gate that passed.
   */
  readonly heldOutPass: boolean | null;
  /** CO-PRIMARY METRIC 2, from `deriveFalseFinish`. Null when undetermined. */
  readonly falseFinish: boolean | null;
}

export interface RunDetail extends RunSummary {
  readonly ticketText: string;
  readonly phase: ApiPhase;
  readonly criteria: readonly ApiCriterion[];
  /**
   * THE BUILDER'S ROW, IN THE BUILDER'S VENDOR. NOT THE RUN'S SPEND.
   *
   * tokens.ts's header states the rule that makes it so: counts are per vendor
   * and are never summed across them, and on a Codex run the spec, audit and
   * judge seats are Anthropic while this field is OpenAI's. Measured on the live
   * run, it reported 88,529 output tokens for a ticket that spent 525,471 across
   * all seats — 16.8% of it, correct about the builder and silent about the rest.
   *
   * THE RUN'S SPEND IS {@link ApiRunSpend}, one row per seat and one total per
   * vendor. WHO SERVES IT IS STILL OPEN, and it is stated here rather than left
   * to be discovered: `RunStore.runSpend` builds it from persisted rows and is
   * tested from `recordSeatSpend` outward, `run-report.ts` renders it to
   * `spend.md`, and the client mirrors every shape — but this interface is
   * CONSTRUCTED by an object literal in `http.ts#toDetail`, which belongs to
   * another wave, so a required field here would not compile. The five
   * `recordSeatSpend` call sites are named in {@link ApiSpendSeat}'s docblock.
   */
  readonly tokens: ApiTokens | null;
  /**
   * ALWAYS null for a subscription run. See the file header.
   *
   * AND `null` HERE IS NOT "not measured yet". There is no number to measure.
   * {@link ApiRunSpend.pricing} carries that statement in a field, because both
   * `null` and `run.json`'s literal `totalCostUsd: 0` get read as "this run was
   * free".
   */
  readonly costUsd: number | null;
  readonly rateLimit: ApiRateLimit | null;
  /**
   * How long this run has been quiet, or `null` when it is not being watched.
   *
   * DERIVED PER REQUEST, PERSISTED NOWHERE, AND THAT IS WHAT MAKES IT SURVIVE A
   * RESTART. It is computed from `RunStore.lastRunEventAt` and the clock at the
   * moment the response is assembled, so a dashboard that has just booted
   * reports the true silence of every run immediately — before any timer exists,
   * and without a column that could disagree with the events it summarises. The
   * watch timer in `orchestrator.ts` announces; this field measures.
   *
   * READ {@link ApiRunSilence} BEFORE RENDERING IT. `null` is "not watched", not
   * "healthy", and `overThreshold` is "we have heard nothing for N minutes", not
   * "this run is dead".
   */
  readonly silence: ApiRunSilence | null;
  readonly screenshots: readonly ApiScreenshot[];
  /**
   * The REFERENCE IMAGES the owner attached to this ticket, each with a URL.
   *
   * NOT THE SAME THING AS `designLock.mockups`, and the two must not be merged
   * in a renderer: those are mockups `ui-designer` GENERATED for this run and
   * they answer "what did the machine propose"; these are the owner's own
   * uploads and they answer "what did I hand it". A design board and a mockup
   * side by side under one heading is a comparison nobody asked for.
   *
   * FOLDED FROM THE REFERENCE MANIFEST ON DISK, not from the row — the bytes and
   * their digests were never in SQLite. An EMPTY LIST therefore means "none were
   * attached" OR "the manifest could not be read", which is
   * `readReferenceManifest`'s existing flattening and not a new one; the
   * distinction it keeps is the one a renderer needs, which is whether there is
   * anything to show. It does NOT include the screenshots `runCapture` writes
   * into the same directory when a ticket names a page — those are the
   * dashboard's reading of a page, not the owner's upload, and only the
   * manifest can tell them apart.
   */
  readonly references: readonly ApiAttachment[];
  /**
   * The DOCUMENTS the owner attached to this ticket — a scope, a brief, a CV.
   *
   * Same folding and the same empty-list flattening as
   * {@link RunDetail.references}, off the same manifest.
   *
   * A URL HERE MEANS THE OWNER CAN READ IT. WHICH AGENTS ALSO READ IT IS A
   * SHORTER LIST THAN "the run", AND THIS FIELD DOES NOT SAY WHICH.
   *
   * THE WIRING EXISTS — this docblock said it did not, and was wrong from the day
   * `#seatDocuments` landed. Read off `orchestrator.ts` on 2026-08-02, that
   * method has three call sites and each hands the documents to a named seat:
   *
   *   `#planOpening`   -> the PLAN seat's opening turn      } ONLY when the plan
   *   `#planFollowUp`  -> the PLAN seat, every follow-up turn } phase runs
   *   `#specPhase`     -> the SPEC seat, on EVERY call it makes — the first
   *                       authoring attempt and every regeneration after it
   *
   * THE FIRST TWO ARE GATED AND THE THIRD IS NOT. `planPolicy(row.interactive)`
   * returns `skip` for a run that was not submitted from the dashboard — a CLI
   * or cron ticket — and that branch makes NO seat call at all, so on those runs
   * the plan seat never sees a document. The spec seat is on the unconditional
   * path.
   *
   * The run says so itself: `#specPhase` emits `the spec seat will see N
   * attached document(s) on every call it makes`. What a seat receives is a
   * `SeatDocument` — the bytes as a native document block where the vendor
   * accepts them, otherwise text extracted by `pdftotext`/`textutil`, and the
   * run logs a `warn` naming the route when the extractor is unusable.
   *
   * AND ONE SEAT DELIBERATELY GETS NONE. The audit/judge caller in `#specPhase`
   * is constructed WITHOUT documents, with the cost written down at its
   * construction site: it grades the draft suite's shape rather than its
   * fidelity to the scope, so a criterion the spec seat mis-derived from page 4
   * of the owner's document is not something the auditor can catch. The BUILDER
   * is not on the list either.
   *
   * SO DO NOT RENDER THIS AS "the run has read your scope", and do not render it
   * as "stored, never read" either — both are claims about a specific run that
   * only that run's own trace can settle. `POST /api/runs`'s intake `warn` still
   * says STORED, NOT READ and is now the stale half of that pair; the accurate
   * sentence for a UI is that the owner can open these, and the run's log names
   * which seats were given them.
   */
  readonly documents: readonly ApiAttachment[];
  readonly artifactPath: string | null;
  readonly previewUrl: string | null;
  /**
   * Where the finished code was COPIED so the owner can find it, or `null` when
   * no publish has been recorded for this run.
   *
   * READ {@link ApiPublishedProject} BEFORE RENDERING IT — it has three states,
   * not two, and `null` (never attempted) is not `published: false` (attempted
   * and declined with a reason).
   *
   * IT IS NOT A SECOND `artifactPath` AND NOT A `previewUrl`. `artifactPath` is
   * the run's own workspace, which is also the scorer's input and stays exactly
   * where it is; this is a copy of it with the scaffolding stripped, outside the
   * run directory, which the owner may edit or delete without touching the run.
   * `previewUrl` is a dead address on every existing run.
   *
   * SERVED FROM `results/project-publish.json`, READ SERVER-SIDE, like
   * `designLock` and `adversary`. `results/` is NOT opened to the browser and
   * must not be — it holds held-out test titles, and the workspace-only fence in
   * `code-files.ts` is a security control.
   *
   * NO SSE EVENT ANNOUNCES IT. The record is written inside `#finish` BEFORE the
   * terminal `status` event is emitted, and the client already revalidates this
   * response on a terminal status, so a new event type would carry a fact this
   * response already carries. The publish also announces itself as an ordinary
   * `log` event on the run's stream, which is what the owner actually reads.
   */
  readonly publishedProject: ApiPublishedProject | null;
  /**
   * Criteria this run was graded against that the owner did NOT state.
   *
   * The predicate is `Assumption.source !== "ticket"` — the grader's guesses AND
   * the house defaults — and it is the same one `verdict.ts` renders as "N of M
   * criteria were inferred rather than stated in your ticket". Two numbers under
   * one name is how an owner learns to distrust both, so `run-report.ts` owns
   * the single expression and `assumptions.md` splits it further into guesses
   * and defaults.
   *
   * 0 until the spec phase exits: nothing has been assumed yet, and 0 is then
   * the true count rather than a placeholder.
   */
  readonly inferredCriteria: number;
  /**
   * Absolute host path to `runs/<runId>/results/verdict.md`.
   *
   * EMPTY UNTIL THE RUN IS TERMINAL, and empty means "not written", not "not
   * found". A run that is still building, queued, or stopped on a rate limit has
   * no verdict yet — `rate_limited` is not terminal — and reporting a path to a
   * file that does not exist would be the same lie as reporting `heldOutPass:
   * false` for a gate that never ran.
   */
  readonly verdictPath: string;
  /**
   * Gate runs actually performed by the GATE/FIX loop. 1 means "gated once".
   *
   * ZERO IS "THE LOOP HAS NOT PRODUCED AN OUTCOME", NEVER "the gate passed
   * first time" — that is 1. A queued run, a run still building, a run stopped
   * on a rate limit and a run cancelled before the gate all read 0, and 0 is the
   * true count for every one of them rather than a placeholder. It is the same
   * refusal `heldOutPass: null` makes: a gate that did not run must never be
   * indistinguishable from a gate that did.
   */
  readonly gateAttempts: number;
  /**
   * Why the GATE/FIX loop stopped, or `null` when it has not stopped.
   *
   * `null` IS NOT `"green"`. It means no loop outcome has been recorded for this
   * run — the same fact `gateAttempts: 0` carries, and the two move together. A
   * UI that renders a missing reason as a pass reproduces exactly the conflation
   * this contract refuses everywhere else.
   *
   * A STRING, NOT A UNION, AND THAT IS A DECISION RATHER THAN LAZINESS. The
   * vocabulary is `StopReason` in `gate-fix-loop.ts` — `green`, `retry-cap`,
   * `not-converging`, `infra`, `cancelled` — and this file imports nothing, for
   * the reason given on {@link ApiDesignLock.lockedBy}: the frozen wire contract
   * must not drag domain modules into the client's mental model. Repeating the
   * union here instead would be a second spelling needing its own compile-time
   * join, for a field whose renderer needs a default branch either way — a
   * newer server can send a reason this client has never heard of, and that is a
   * newer server, not a bug. `backlog.ts` holds the owner-facing prose for each.
   *
   * WHO WRITES IT, AND WHAT IS STILL OPEN. `runGateFixLoop` returns
   * `{attempts, reason}`; `orchestrator.ts#gateFixLoop` is the one place that
   * holds that result next to the run id, and until it calls
   * `store.updateRun(runId, {gateAttempts, gateStopReason})` every run reports
   * `0`/`null` here. That is stated rather than left to be discovered: the
   * store, the migration, this contract, the client mirror and the route are
   * all in place and tested end-to-end from `updateRun` outward, and the one
   * remaining line is in a file that belongs to another wave.
   */
  readonly gateStopReason: string | null;
  /**
   * The last thing that went wrong on this run, in the words it was recorded in.
   *
   * IT IS NOT A STATUS AND MUST NOT BE RENDERED AS ONE. A non-null value does
   * NOT mean the run failed, and this is measured rather than feared: a run
   * parked at `awaiting_input` carries `DESIGN LANE FAILED (too-few-images)`
   * while it is still live and still resumable (`orchestrator.test.ts:1528-1540`).
   * `rate_limited` is the same shape — stopped, not finished, not failed. Read
   * `status` for whether the run failed; read this for WHY, and only alongside a
   * status that already says something went wrong.
   *
   * LAST WRITE WINS, ACROSS FIVE WRITERS, AND IT IS NOT A HISTORY.
   * `orchestrator.ts` writes it at :735 (a harness fault escaping `#execute`),
   * :859 (`the sealed gate could not run …`), :881 (the held-out suite was not
   * green — a constant string, and `null` when it WAS green, so a passed run
   * clears the column), :1473 (the build did not complete cleanly) and :1501 (the
   * DESIGN lane failed). A run whose design lane failed and which then reached
   * the gate reports the GATE's answer; the lane's is durable only in
   * `results/design-lane.json` and in the error-level event
   * (`orchestrator.test.ts:1509-1517` documents exactly this and refuses to
   * pretend otherwise). Do not present it as "the reason this run failed" when
   * the two could be different sentences.
   *
   * WIDENING IT TO THE WIRE DISCLOSES NOTHING NEW. Every non-constant value is
   * already an SSE `log` event on the same stream, emitted immediately before it
   * is stored: :731 before :735, :2141 before :859, :1472 before :1473, :1500
   * before :1501. This field moves it out of a 32,000-row trace and into the one
   * place that says the run failed.
   *
   * REDACTED, BUT ONLY IN THE SENSE `redactForPersistence` MEANS. The single
   * write site is `db.ts:746`, which runs the chokepoint over it before the
   * column is set, so credential-shaped spans are already replaced. That is
   * PATTERN-BASED and is not a general guarantee about content: a
   * `suite_hash_mismatch` refusal, for instance, quotes the integrity problems it
   * found, which name files under the sealed suite. That text has always been on
   * the log stream (above); this field does not make it more reachable, and it
   * does not make it safe to render somewhere new without reading it.
   */
  readonly failureReason: string | null;
  /**
   * The DESIGN lane's lock, or `null` when this run has no DESIGN lane.
   *
   * ONE NULLABLE FIELD RATHER THAN FOUR FLAT ONES, AND THE NULL IS LOAD-BEARING.
   * `null` means "this run has no DESIGN lane at all"; `{awaiting: false,
   * locked: null, …}` means "the lane ran and produced nothing to lock" — a
   * degraded lane, or one that failed. Those are different facts, and the UI
   * says different things about them. A flat pair of `awaiting: boolean` and
   * `locked: string | null` could not express the difference: both cases would
   * read as `false, null`.
   */
  readonly designLock: ApiDesignLock | null;
  /**
   * The human-factors adversary pass, or `null` when this run left no record.
   *
   * ITS PRODUCER HAS NEVER RUN. `#adversaryPhase` needs a `previewUrl` and no
   * run on this machine has reached it, so `null` is what every existing run
   * reports and will keep reporting until one does. Read
   * {@link ApiAdversaryPass} before rendering any of it: the null on THIS field
   * and the null on `findings` inside it say different things, and the second
   * one is the distinction the whole shape exists for.
   *
   * SERVED FROM `results/adversary.json`, READ SERVER-SIDE. `results/` is NOT
   * opened to the browser and must not be: it holds held-out test titles, and
   * the workspace-only fence in `code-files.ts` is a security control rather
   * than a routing convenience. This field carries the four values a panel needs
   * and nothing else, on a response the client already fetches.
   *
   * IT IS THE REDACTED COPY, in the sense `redactForPersistence` means — the one
   * writer (`orchestrator.ts#recordAdversary`) runs the chokepoint over the
   * record before the file is written, so credential-shaped spans are already
   * replaced. That is PATTERN-BASED and is not a guarantee about content: the
   * findings are model-written prose about a live app, and this field does not
   * make that prose safe to render somewhere new without reading it.
   *
   * NO SSE EVENT ANNOUNCES IT, deliberately. The record is written inside
   * `#adversaryPhase`, which runs BEFORE `#finish` emits the terminal `status`,
   * and the client already revalidates this response on a terminal status
   * (`use-run-stream.ts:869-872`). A new event type would have to be added to
   * the client's `EVENT_TYPES`, its `RunEvent` union and `parseRunEvent` to
   * carry a fact this response already carries.
   */
  readonly adversary: ApiAdversaryPass | null;
}

/* -------------------------------------------------------------------------
 * The orchestration canvas — spec §9.1
 *
 * SEVEN NEW MEMBERS ON THE EXISTING UNION, NOT A PARALLEL CHANNEL. Total
 * ordering against `status`/`phase` is a CORRECTNESS requirement — an agent must
 * not show "running" inside a cancelled run — and `seq` gives it for free, along
 * with `Last-Event-ID` resumability that already works and is already exact.
 *
 * ZERO DDL. `events(run_id, seq, at, payload)` already exists, `payload` is
 * opaque JSON, and the read path is an unchecked `JSON.parse(...) as SseEvent`.
 * So live-canvas and replay-an-old-run are ONE code path — `foldGraph` over an
 * SSE tail or over `eventsSince(runId, 0)` — and an old run, which contains no
 * `graph_*` rows at all, folds to an empty canvas BY CONSTRUCTION. There is no
 * feature flag, because there is nothing to flag.
 * ---------------------------------------------------------------------- */

/**
 * Did the emitter KNOW which node this belongs to, or did it work it out?
 *
 * REQUIRED ON EVERY EVENT THAT NAMES A NODE, and that is the whole point. Hook
 * messages carry no task identity, so hook→agent attribution is a SERVER-SIDE
 * INFERENCE; a required field forces every emitter to say whether it knew or
 * guessed, and lets the canvas draw an inferred edge differently instead of
 * lying. An optional field would have been left off at exactly the call sites
 * where the answer is "guessed".
 *
 * It marks a GUESSED edge. It can never launder a WRONG node: an event whose
 * node cannot be determined is dropped, not re-pointed at the root.
 */
export type GraphAttribution = "exact" | "inferred";

/** Delivery lane. Mirrors `Lane` in `agent-shortlist.ts`, structurally. */
export type ApiLane = "spec" | "design" | "build" | "review" | "gate";

/**
 * An agent's state, in the CLI's own words.
 *
 * `unresolved` is NOT here on purpose: it is derived by `foldGraph` when a run
 * goes terminal with an agent still reading `running`, and no emitter may claim
 * it, because no message ever says it.
 */
export type GraphAgentState = "running" | "completed" | "failed" | "stopped";

/**
 * Raw SDK identifiers, FOR THE INSPECTOR ONLY.
 *
 * NEVER IDENTITY, AND THAT IS FORCED BY MEASUREMENT. `redactForPersistence`
 * rewrites any 40+ character mixed-case-and-digit token to the IDENTICAL literal
 * `[REDACTED:HIGH_ENTROPY_TOKEN]`, and `task_id` has no documented length bound.
 * Two distinct agents whose ids crossed that threshold would come back from the
 * events table as the same string and MERGE INTO ONE NODE — silently, with the
 * canvas still rendering. Node identity is therefore a short server-assigned id
 * (`n1`, `n2`, …) that no redactor rewrites, and nothing in `foldGraph` keys on
 * anything in here.
 */
export interface GraphSdkRef {
  readonly taskId: string;
  /** The Agent tool_use block that spawned this task, when the CLI said. */
  readonly toolUseId: string | null;
}

/** One MCP server as the CLI reported it at init. */
export interface GraphMcpServer {
  readonly name: string;
  readonly status: string;
}

/* -------------------------------------------------------------------------
 * SSE
 * ---------------------------------------------------------------------- */

export type SseEvent =
  | { readonly type: "phase"; readonly phase: ApiPhase }
  | { readonly type: "log"; readonly level: "info" | "warn" | "error"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly summary: string }
  | { readonly type: "criterion"; readonly id: string; readonly result: ApiCriterionResult }
  | { readonly type: "screenshot"; readonly path: string; readonly label: string }
  | {
      readonly type: "tokens";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
    }
  /**
   * The provider reported rate-limit state. NOT NECESSARILY A LIMIT.
   *
   * `limited` IS THE WHOLE POINT OF THIS EVENT AND WAS MISSING FOR ITS WHOLE
   * LIFE. The Agent SDK emits `rate_limit_event` routinely with
   * `status: 'allowed' | 'allowed_warning'` and a `resetsAt` naming when the
   * CURRENT window rolls over — ordinary telemetry about a window that is
   * filling, not a refusal. Only `status: 'rejected'` is a limit.
   *
   * Without this flag the event carried a large `retryAfterSec` and nothing to
   * say whether it meant anything, so the client hard-coded `limited: true` and
   * a healthy run printed `rate limited; retry after 253699s` two seconds in —
   * a seven-day window reset 70 hours out, reported while the subscription was
   * working perfectly. Measured on
   * `run-2026-07-30T13-31-38-076Z-c228e63b`, whose row says `rate_limited = 0`.
   *
   * `retryAfterSec` is still carried when `limited` is false, deliberately: it
   * is when the window reopens, which is worth showing as it fills rather than
   * only once it has slammed shut. The client decides how to say that; this
   * event's job is to stop pretending the two cases are one.
   */
  | {
      readonly type: "rate_limit";
      readonly limited: boolean;
      readonly retryAfterSec: number | null;
    }
  /**
   * The run wrote its verdict. Emitted once, immediately BEFORE the terminal
   * `status` event, so a client that revalidates on a terminal status already
   * finds `verdictPath` in the read model.
   *
   * Carries a path and a count and nothing else. The verdict's own content is a
   * file the UI can fetch; putting its text on the event stream would push
   * criterion prose through a second channel with a second set of rules.
   */
  | {
      readonly type: "verdict";
      readonly verdictPath: string;
      readonly inferredCriteria: number;
    }
  | { readonly type: "status"; readonly status: ApiRunStatus }
  /* ---- the canvas, spec §9.1 ------------------------------------------ */
  /**
   * A node exists.
   *
   * ALWAYS FIRST FOR ITS NODE. The invariant is that a node id is never
   * referenced before its `graph_agent`, which is why every event below carries
   * only `node` and none of them carries `lane`: the lane is declared once, here,
   * by the node itself. `foldGraph` DROPS a downstream event naming an unknown
   * node rather than inventing one, so a violation of the invariant loses one
   * pill instead of fabricating an agent.
   *
   * `agent` is nullable because `subagent_type` is optional in the SDK's own
   * typing and ambient tasks carry none. A node is still minted: the task
   * identity is present and exact, and skipping would blank the canvas outright
   * if a CLI version ever stopped sending the field.
   */
  | {
      readonly type: "graph_agent";
      readonly node: string;
      /** The node that delegated to this one. Null for the run's own session. */
      readonly parent: string | null;
      readonly agent: string | null;
      /** Null for an agent in no lane — never a guess. */
      readonly lane: ApiLane | null;
      readonly description: string;
      /** The CLI's `skip_transcript`: housekeeping, hidden by default. */
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
  /**
   * A tool call.
   *
   * MCP IS NOT A SEPARATE EVENT TYPE. An MCP call IS a `tool_use` whose name
   * matches `mcp__<server>__<tool>`; a nullable `mcpServer` carries exactly the
   * same information with no classification risk and no second code path to keep
   * in step.
   */
  | {
      readonly type: "graph_tool";
      readonly node: string;
      readonly name: string;
      readonly mcpServer: string | null;
      readonly summary: string;
      readonly attribution: GraphAttribution;
    }
  /**
   * A skill.
   *
   * `source` contains the blast radius of an unsettled question (spec §10): skill
   * invocation IS observable (`{"name":"Skill","input":{"skill":…}}`), while
   * preloading is not — `Options.agents` was deleted after probe I measured it
   * not binding, so `AgentDefinition.skills` preloads nothing and `"preloaded"`
   * has no producer today. The discriminator stays so that a future preload does
   * not have to be told apart from an invocation after the fact.
   */
  | {
      readonly type: "graph_skill";
      readonly node: string;
      readonly skill: string;
      readonly source: "preloaded" | "invoked";
      readonly attribution: GraphAttribution;
    }
  /**
   * A hook DECIDED something.
   *
   * `attribution` is `"inferred"` here by construction: a hook input carries no
   * task identity, so which agent it belongs to is worked out on this side. This
   * is the event the required field exists for.
   */
  | {
      readonly type: "graph_hook";
      readonly node: string;
      /** `PreToolUse`, `PostToolUse`, … — the CLI's own hook event name. */
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
      /** Null when the CLI reported no usage — NOT 0, which is a claim. */
      readonly totalTokens: number | null;
      readonly toolUses: number | null;
      readonly durationMs: number | null;
      readonly attribution: GraphAttribution;
    }
  /**
   * What the CLI loaded for this run, and what this run may actually reach.
   *
   * COUNTS FOR THE BIG CATEGORIES, NAMES FOR THE SMALL ONES. 154 agents and 162
   * skills are ~4 KB of names that no canvas renders and that
   * `results/environment.json` already holds in full; `allowedAgents` is the
   * ~26-name PERMISSION set, which is the one worth naming, and MCP servers and
   * plugins are small and are what a reader asks about.
   */
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

export type SseEventType = SseEvent["type"];

/**
 * An `SseEvent` as it appears ON THE WIRE: the event, plus the instant the server
 * recorded it.
 *
 * WHY THIS TYPE EXISTS — 2026-07-30. `events.at` has been written for every event
 * since the table was created, and `attachSse` serialised `stored.event` only, so
 * the column was written and never served. Nothing downstream could say WHEN
 * anything happened, which is what the owner asked the node panel for: "what it
 * was looking at in order… with time stamps".
 *
 * THE FIELD IS THE SERVER'S RECORDED TIME AND MUST STAY THAT WAY. The tempting
 * shortcut is for the client to stamp `Date.now()` as events arrive. That is
 * correct on a live run and SILENTLY WRONG on every historical one: `attachSse`
 * replays durable rows as fast as the socket takes them, so all 388 events of a
 * finished run arrive inside a few milliseconds and every row would report the
 * same time — a timeline that looks perfect and measures nothing. `at` comes from
 * the row, live or replayed, so the two paths cannot disagree.
 *
 * ADDITIVE ON PURPOSE. No `SseEvent` member has an `at` field, so widening the
 * payload cannot collide with one and an older client ignores it.
 */
export type SseWireEvent = SseEvent & { readonly at: string };

/**
 * EVERY MEMBER OF `SseEvent`, AS A VALUE — one of the two runtime exports in this
 * file, and it exists so that the CLIENT can be checked against it.
 *
 * (The other is {@link SPEND_SEATS}, which exists for exactly the same reason and
 * carries the same `satisfies` + `Exclude` pair. Two runtime exports, both of
 * them a union projected onto an array so a test in another package can read it.)
 *
 * A type cannot be read from another package's test: `SseEvent` is erased, and
 * `dashboard/src` and `dashboard/server` cannot import each other. So the union's
 * membership is projected onto an array that survives compilation, and
 * `contract-parity.test.ts` compares THIS ARRAY — imported, not scraped — against
 * the three hand-maintained client declaration sites.
 *
 * THE GUARD BELOW IS WHAT MAKES THE ARRAY TRUSTWORTHY IN BOTH DIRECTIONS.
 * `satisfies` rejects a name that is not a real event type; `Unlisted` rejects a
 * union member that is not in the array. Adding a member to `SseEvent` and
 * nothing else therefore FAILS `tsc`, which is the drift this closes: before it,
 * the server could grow an event type that the client mirror, its listener list
 * and its parser knew nothing about, with a clean compile on both sides and a
 * canvas that silently rendered empty.
 *
 * MUTATION-PROVEN, NOT ASSERTED. On 2026-07-29, adding
 * `| { readonly type: "graph_probe_mutation"; readonly node: string }` to
 * `SseEvent` alone failed `npm run build` with, verbatim:
 * `src/api-types.ts(419,7): error TS2322: Type 'true' is not assignable to type
 * 'never'.` — the coordinates are wherever `_sseEventTypesComplete` sat that
 * afternoon and they move whenever this comment does; the error does not.
 * Restored, and clean again.
 *
 * AND THE GUARD ALONE IS NOT THE FIX. It forces the author to touch this array;
 * an author who does exactly what tsc asks still leaves the client ignorant. The
 * same member added to BOTH the union and this array compiled clean and turned
 * all three checks in `contract-parity.test.ts` red — `the server sends
 * graph_probe_mutation and the client's EVENT_TYPES does not name it` — which is
 * the check that actually closes the drift.
 *
 * WHAT IT DOES NOT COVER: it proves the array names the union. It says nothing
 * about the client — that is `contract-parity.test.ts`'s job, and the array is
 * only the ground truth it reads.
 */
export const SSE_EVENT_TYPES = [
  "phase",
  "log",
  "tool",
  "criterion",
  "screenshot",
  "tokens",
  "rate_limit",
  "verdict",
  "status",
  "graph_agent",
  "graph_agent_status",
  "graph_tool",
  "graph_skill",
  "graph_hook",
  "graph_result",
  "graph_inventory",
] as const satisfies readonly SseEventType[];

type UnlistedSseEvent = Exclude<SseEventType, (typeof SSE_EVENT_TYPES)[number]>;
const _sseEventTypesComplete: UnlistedSseEvent extends never ? true : never = true;
void _sseEventTypesComplete;

/**
 * EVERY MEMBER OF {@link ApiSpendSeat}, AS A VALUE, for the same two consumers the
 * array above has.
 *
 * ONE: `db.ts` reads it as its `oneOf` vocabulary, so the store's guard and the
 * wire union cannot name different seats — a hand-copied list there is a second
 * declaration site, and a seat missing from it throws `spend seat "fix" is not
 * one of …` on a row this server itself wrote.
 *
 * TWO: `contract-parity.test.ts` imports it as the GROUND TRUTH for the client's
 * hand-written `SpendSeat` mirror. A type cannot be read from another package's
 * test — `ApiSpendSeat` is erased — and both sides read as text can agree by
 * matching nothing on both sides.
 *
 * The `satisfies` rejects a name that is not a seat; the `Exclude` guard below
 * rejects a seat that is not in the array, so adding a member to `ApiSpendSeat`
 * and nothing else FAILS `tsc` rather than shipping a seat the store refuses to
 * read back.
 */
export const SPEND_SEATS = [
  "spec",
  "audit",
  "builder",
  "fix",
  "judge",
] as const satisfies readonly ApiSpendSeat[];

type UnlistedSpendSeat = Exclude<ApiSpendSeat, (typeof SPEND_SEATS)[number]>;
const _spendSeatsComplete: UnlistedSpendSeat extends never ? true : never = true;
void _spendSeatsComplete;

/**
 * The canvas half of the union, by construction rather than by hand.
 *
 * `BuildEventSink.graph` takes this, so a driver cannot post a `status` or a
 * `tokens` event down the graph seam, and adding a `graph_*` member to `SseEvent`
 * widens the seam automatically. A hand-written second list would be a fourth
 * declaration site — this file's whole problem, one layer down.
 */
export type GraphSseEvent = Extract<SseEvent, { readonly type: `graph_${string}` }>;

/* -------------------------------------------------------------------------
 * The folded canvas — what `GET /api/runs/:id/graph` returns
 * ---------------------------------------------------------------------- */

/**
 * A node's state, including the one no emitter may claim.
 *
 * `unresolved` means THE RUN ENDED WHILE THIS AGENT STILL READ RUNNING and the
 * stream never said how it finished. It is NOT `failed`: a cancelled run's
 * in-flight agents did not fail, and this codebase already refuses that
 * conflation everywhere else (`heldOutPass: null` is not `false`).
 */
export type GraphNodeState = GraphAgentState | "unresolved";

/**
 * Distinct tool names with a call count, NOT one pill per call.
 *
 * A single agent makes thousands of tool calls and the canvas draws pills. The
 * count is exact and unbounded; the number of DISTINCT names is capped, and the
 * node's own `toolCalls` keeps the true total either way, so a capped node is
 * visibly capped rather than quietly wrong.
 */
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

/*
 * `ACTIVITY_CAP` AND `ACTIVITY_DETAIL_CHARS` LIVE IN `graph.ts`, NOT HERE, and
 * that placement is load-bearing rather than tidy.
 *
 * This file is imported by the browser through `src/lib/graph.ts` — which
 * re-exports the server's reducer so there is only one of it — and it is imported
 * there with `import type` ONLY, so the statement is erased and Turbopack never
 * resolves the specifier. Exporting a runtime VALUE from here and using it in
 * `graph.ts` turns that erased import into a real one, with a `.js` specifier that
 * `moduleResolution: "bundler"` maps onto the neighbouring `.ts` and TURBOPACK DOES
 * NOT:
 *
 *   Module not found: Can't resolve './api-types.js'
 *       ./server/src/graph.ts [Client Component Browser]
 *
 * That is the same failure `src/lib/graph.ts` documents at length, and it was
 * re-created and observed on 2026-07-30 by putting these two constants here. It
 * type-checks clean and the dev server 500s, which is why the note is a warning
 * rather than a preference. `PILL_KINDS_CAP` was already in `graph.ts` for exactly
 * this reason; the new caps join it there.
 */

/**
 * One thing an agent did, in the order it did it.
 *
 * WHY THIS EXISTS ALONGSIDE `tools`. `tools` is a SET with counts —
 * `[{name:"Bash",count:60}]` — which answers "what did it use" and destroys "in
 * what order". The owner asked for the other question: "what it was looking at in
 * order, what he is looking at right now, with time stamps… designing the hero
 * image or text boxes". That cannot be recovered from a counted pill, so it is
 * recorded separately rather than derived.
 *
 * `at` IS NULLABLE AND THE NULL MEANS SOMETHING. Rows written before the wire
 * carried `events.at` (see {@link SseWireEvent}) fold to `null` here, and a null
 * renders as "time not recorded" — never as a guess and never as the fold's own
 * clock, which would date a two-year-old run to the moment somebody opened it.
 */
export interface GraphActivityEntry {
  /** ISO instant the SERVER recorded the event. Null when the row predates it. */
  readonly at: string | null;
  readonly kind: "tool" | "skill";
  /** Tool or skill name, e.g. `Bash`, `Read`, `imagegen-frontend-web`. */
  readonly name: string;
  /** The event's own summary, truncated to {@link ACTIVITY_DETAIL_CHARS}. */
  readonly detail: string;
  /** True when `detail` was cut. Stops a clipped path reading as a whole one. */
  readonly truncated: boolean;
}

export interface GraphNode {
  readonly id: string;
  readonly parent: string | null;
  readonly agent: string | null;
  readonly lane: ApiLane | null;
  readonly description: string;
  readonly ambient: boolean;
  readonly state: GraphNodeState;
  readonly attribution: GraphAttribution;
  readonly sdk: GraphSdkRef | null;
  readonly tools: readonly GraphToolPill[];
  readonly skills: readonly GraphSkillPill[];
  readonly hooks: readonly GraphHookPill[];
  /** Every tool call, even the ones whose name did not fit in `tools`. */
  readonly toolCalls: number;
  readonly result: GraphResult | null;
  /**
   * What this agent did, oldest first, capped at {@link ACTIVITY_CAP}.
   *
   * The chronology `tools` cannot hold. Empty for a node that only ever reported
   * a status.
   */
  readonly activity: readonly GraphActivityEntry[];
  /**
   * Entries past the cap. Non-zero means `activity` is a PREFIX of what happened,
   * not the whole of it — the same honesty rule as `toolCalls` vs `tools`.
   */
  readonly activityDropped: number;
}

/**
 * A delegation edge.
 *
 * `attribution` is the CHILD's: an edge drawn from a parent the emitter had to
 * guess is rendered differently, which is the entire reason the field is
 * required rather than optional.
 */
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
 * The whole canvas, as a value.
 *
 * `inventory` is NULL until a `graph_inventory` event arrives, and null means
 * "nothing was recorded", never "the CLI reported nothing". An empty object
 * would make those two indistinguishable — the same defect as a gate that could
 * not run being reported as a gate that passed.
 */
export interface GraphState {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly inventory: GraphInventory | null;
}

/**
 * `GET /api/runs/:id/graph`.
 *
 * A WIRE-SIZE FIX, NOT A CPU ONE. Measured on a 32,000-row run: `eventsSince`
 * returns in 22.7 ms and parses in 11.7 ms — and is 7.01 MB on the wire. The
 * client folds this once, then opens `EventSource(…?lastEventId=atSeq)`.
 *
 * `atSeq` IS A DURABLE WATERMARK: the seq of the last persisted row that went
 * into this fold. `attachSse` replays from durable rows, so the window between
 * the snapshot and the EventSource is not a race — but only because of that.
 */
export interface RunGraphResponse extends GraphState {
  readonly atSeq: number;
}

/**
 * Can the SEALED GATE be built on this machine? — `HealthResponse.gate`.
 *
 * THREE STATES, AND THE THIRD ONE IS THE POINT. `unknown` means no probe has
 * completed yet: the answer is not "fine", it is absent. A renderer may treat
 * ONLY `"ok"` as a pass; `unknown` gets its own neutral presentation and never
 * the green one, for the same reason `heldOutPass: null` is not `false` — a
 * check that could not run must never be indistinguishable from a check that
 * passed. That rule is written here because the renderer lives in another
 * package and this declaration is the only thing both sides read.
 *
 * WHAT `ok` MEANS, EXACTLY. The server built the gate with
 * `createGate(gateEnv(...))` — the same call, the same environment and the same
 * image reference the gate phase uses — and it resolved the scorer image's
 * digest from the docker daemon. It does NOT mean a scoring container has been
 * run, that any ticket's frozen suite exists, or that docker will still be up
 * when the run reaches the gate ~1h45 later. `health-gate.ts` states the same
 * limits at the probe.
 *
 * `detail` IS OWNER-FACING PROSE AND MAY BE MULTI-LINE. On `unavailable` it is
 * `describeError` of whatever `createGate` threw, which for the usual cause is
 * `[invalid_usage_shape] the scorer image … could not be resolved` followed by a
 * `fix:` line carrying the exact `docker build` command. Render it with the
 * newlines preserved, or the command runs into the prose.
 *
 * `checkedAt` IS WHEN THE ANSWER WAS TAKEN, and it is `null` exactly when
 * `state` is `"unknown"`. The probe is cached, so an `ok` can be up to a minute
 * old — that is what this field is for, and why `ok` is not a claim about now.
 */
export interface GateHealth {
  readonly state: "ok" | "unavailable" | "unknown";
  readonly detail: string;
  readonly checkedAt: string | null;
}

export interface HealthResponse {
  /**
   * AUTH ONLY, DELIBERATELY, AND `gate` IS NOT FOLDED IN.
   *
   * `cron-tick.ts:261-270` treats `ok: false` as "no CLI is authenticated" and
   * refuses to submit the tick's ticket, naming that cause. A gate outage is not
   * that fact and does not have that remedy: a run with docker down still
   * builds, still produces code and still ends with a verdict page — it just
   * cannot be scored. Folding the gate in here would stop the unattended
   * scheduler with a message that names the wrong thing.
   */
  readonly ok: boolean;
  readonly claudeAuth: "ok" | "missing";
  readonly codexAuth: "ok" | "missing";
  readonly gate: GateHealth;
}

export interface CreateRunRequest {
  readonly ticketText: string;
  readonly modelId: string;
  readonly deploy: boolean | null;
  /**
   * §17.3 rule 2: a cron-submitted run auto-selects its mockup.
   *
   * `null` or absent means AUTO for a non-interactive caller — a scheduled run
   * that parks forever waiting for a click is the exact failure unattended
   * operation exists to avoid. `designLockInteractive` in http.ts is where
   * "interactive" is defined, and CONCERN 6 in the Phase 2b plan is why the
   * failure direction is the one it is.
   */
  readonly designLock: "auto" | "ask" | null;
  /**
   * Reference images for the ticket, as base64 `data:image/…` URLs.
   *
   * SAME CAPS AS THE CHAT'S IMAGE INTAKE, from one declaration
   * (`ticket-refs.ts`): at most 6, at most 8 MB each decoded, png/jpeg/webp/gif.
   * The bytes are written under `runs/<id>/references/` and only PATHS are
   * recorded — a 2 MB PNG has no business in SQLite.
   *
   * THEY CHANGE THE TICKET'S IDENTITY. `ticketWithReferences` folds their sha256
   * digests into the ticket id, so the same words with a different image is a
   * DIFFERENT ticket with its own frozen acceptance suite. The owner chose this
   * deliberately, accepting that re-uploading the same file mints a new ticket
   * and re-authors a suite: the alternative is two runs with different visual
   * briefs sharing one sealed suite, where the verdict cannot say which
   * reference the build was graded against.
   *
   * WHO ACTUALLY SEES THEM: the BUILDER and the DESIGN lane, as absolute paths
   * in their prompts. NOT the spec seat, which is constructed with `tools: []`
   * and cannot open a file — it is not even told an image exists, because a
   * criterion written about an unseen image grades for untraceable reasons.
   * AND, since `GET /api/runs/:id/references/:file` exists, THE OWNER: they come
   * back on {@link RunDetail.references} as {@link ApiAttachment}s with URLs a
   * page can render. That route reads the manifest, so what the dashboard shows
   * is exactly what entered the ticket id.
   */
  readonly references: readonly string[] | null;
  /**
   * Documents for the ticket — a scope, a brief, a CV — as base64 data URLs.
   *
   * CAPS AND ACCEPTED TYPES COME FROM ONE DECLARATION (`document-intake.ts`): at
   * most 4, at most 12 MB each decoded, and the accepted media types are PDF,
   * plain text, markdown, CSV, JSON, .docx, .doc and both spellings of RTF.
   * The bytes are written under `runs/<id>/documents/` and only PATHS, DIGESTS,
   * SIZES and MEDIA TYPES are recorded — a 12 MB PDF has no business in SQLite,
   * and a document's base64 cannot be redacted, so persisting it would persist
   * whatever credential the file contains.
   *
   * THEY CHANGE THE TICKET'S IDENTITY, exactly as `references` do: each one's
   * sha256 is folded into the ticket id, so amending a scope document and
   * re-submitting the same words is a DIFFERENT ticket with its own frozen
   * acceptance suite. That is the point rather than a side effect — a suite
   * authored from the old scope is not a yardstick for work done against the new
   * one — and the cost is the same one the images already carry: quota, spent
   * re-authoring.
   *
   * WHAT SENDING ONE DOES NOT DO. The intake stores the document and folds its
   * digest into the id. It does not, by itself, put the document in front of any
   * agent: that is the build and spec wiring's decision, and the server says so
   * on the run's event stream with a `warn` naming where the file was stored. A
   * form offering "attach a scope" must not imply the run has read it. THE OWNER
   * CAN NOW READ IT, which is a different claim: it comes back on
   * {@link RunDetail.documents} with a URL, served by
   * `GET /api/runs/:id/documents/:file`.
   *
   * REFUSALS ARE NAMED: `too_many_documents`, `invalid_document` (with a sentence
   * naming the actual type or the actual byte count), and `body_too_large` when
   * the whole envelope is over the route's cap.
   */
  readonly documents: readonly string[] | null;
  /**
   * Which page to capture at ticket time, if any.
   *
   * THREE MEANINGS. A string names a page explicitly. `null` is the OPT-OUT:
   * capture nothing, even if the ticket text contains a URL. Absent means scan
   * the ticket text and capture the first http(s) URL in it — which is the case
   * "make a copy of kamilborzecki.dev" falls into, and the reason the scan
   * exists at all.
   *
   * The capture runs ON THE HOST, INSIDE THIS REQUEST, because that is the only
   * moment the network is both present and permitted: the sealed scorer runs
   * `--network none` and must keep doing so. It produces screenshots for the
   * builder and a TEXT OUTLINE that is composed into the ticket brief, so the
   * acceptance suite can name real sections of the real page.
   *
   * WHAT IT DOES NOT DO: it does not let the gate compare the build to the live
   * site. There is no visual diff anywhere in this system.
   *
   * A capture failure does NOT fail the request. The run is created, a `warn`
   * lands on its event stream saying the suite will be written from the words
   * alone, and the ticket id is then the prose-only one.
   *
   * IT IS SLOW. `site-capture.ts` bounds launch, navigation and each screenshot,
   * and those bounds sum to roughly a minute; two DOM reads are additionally
   * bounded only by playwright's own default. The POST blocks for all of it.
   */
  readonly captureUrl: string | null;
}

export interface CreateRunResponse {
  readonly runId: string;
}

/**
 * `POST /api/runs/:id/messages` — the owner↔run chat, as the server reads it.
 *
 * WRITTEN DOWN BECAUSE THE ROUTE GREW A SECOND ATTACHMENT KIND, and until now
 * the body was described only in prose in `http.ts` and constructed inline by
 * one `fetch` in the client. Two attachment arrays with no declared shape is how
 * a client sends `document` and a server reads `documents` and nobody finds out
 * until an owner's scope silently does nothing.
 *
 * EVERY FIELD IS OPTIONAL, BUT NOT ALL AT ONCE. A message needs text, at least
 * one image, or at least one document; an entirely empty body is refused as
 * `empty_message`.
 *
 * `images` — data URLs, at most 6, at most 8 MB each decoded (png/jpeg/webp/gif).
 * Stored under `runs/<id>/chat/`, and their PATHS reach the running agent with
 * an instruction to read them.
 *
 * `documents` — data URLs, the caps and types `CreateRunRequest.documents`
 * describes, decoded by the same module so the two intakes cannot drift. Stored
 * under `runs/<id>/chat/` as well. THEY ARE NOT PART OF THE TICKET'S IDENTITY:
 * the run's ticket id was fixed when its row was written, and a mid-run
 * attachment that moved it would point a live run at a different frozen suite.
 * AND THEY ARE NOT DELIVERED TO THE AGENT — the chat channel carries text and
 * image paths only — so the server stores them, answers with their paths on the
 * response's additive `documents` field, and emits a `warn` on the run's event
 * stream saying exactly that. A client that renders "sent" for a document
 * without surfacing that warning is telling the owner something the server did
 * not do.
 */
export interface SendMessageRequest {
  readonly text?: string;
  readonly images?: readonly string[];
  readonly documents?: readonly string[];
}

export interface OkResponse {
  readonly ok: true;
}

/** Every error body has this shape, and never contains a credential. */
export interface ApiErrorResponse {
  readonly error: string;
  readonly message: string;
  readonly remediation: string | null;
}

/* -------------------------------------------------------------------------
 * `GET /api/runs/:id/files` — the code the run produced
 *
 * ADDITIVE, and ONE route with two responses discriminated by `kind`: no
 * `?path` returns the whole tree, `?path=<relative>` returns that file. The
 * alternative was two routes whose deny-lists could drift apart, and a viewer
 * whose sidebar hides `.git/config` while its content route serves it has a
 * security control made of politeness. `code-files.ts` holds the refusals and
 * says why each one is shaped the way it is.
 * ---------------------------------------------------------------------- */

/**
 * One node of the run's workspace.
 *
 * `path` IS THE KEY AND THE REQUEST. It is relative to the workspace root with
 * forward slashes and no leading slash, which is exactly the spelling
 * `?path=` accepts — one string, one meaning, so a client cannot construct a
 * path the server has not already listed.
 *
 * `bytes` is `null` for a directory and the size on disk for a file. For a
 * truncated file it stays the FULL size: the UI says "showing 256 KB of 12.4 MB",
 * which it cannot do if the only number it has is the one it received.
 */
export interface CodeTreeEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "dir" | "file";
  readonly bytes: number | null;
}

/**
 * Something in the workspace that was NOT listed, and why.
 *
 * On the wire deliberately. A viewer that silently drops `.git` and
 * `node_modules` is indistinguishable from a viewer that failed to read the
 * directory, and the owner cannot tell an empty workspace from a filtered one.
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
  /** The entry cap was hit. Some of the workspace is not in `entries`. */
  readonly truncated: boolean;
}

/**
 * One file's contents.
 *
 * `text` IS NULL FOR THREE DIFFERENT REASONS AND THE UI MUST NOT CONFLATE THEM:
 * `binary` true means bytes that are not text; `withheld` non-null means the
 * redaction self-check refused the file; both false/null with `text` null cannot
 * happen. `bytes` is always the size on disk, so `truncated` plus `bytes` says
 * exactly how much is missing.
 */
export interface CodeFileResponse {
  readonly kind: "file";
  readonly runId: string;
  readonly path: string;
  readonly bytes: number;
  readonly text: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
  /** How many spans `redactForPersistence` replaced. 0 = nothing matched. */
  readonly redactions: number;
  readonly withheld: string | null;
}

export type CodeResponse = CodeTreeResponse | CodeFileResponse;

/* -------------------------------------------------------------------------
 * `GET /api/runs/:id/preview/*` — the built site, served BY THE DASHBOARD
 *
 * WHY THE ROUTE EXISTS: `RunDetail.previewUrl` IS A DEAD ADDRESS. It is the
 * `http://127.0.0.1:<port>` a `deploy: true` run served its workspace on
 * (`preview.ts`), and the process that answered it was started by the run and
 * EXITED WITH IT. Measured on the recorded run: `previewUrl` is
 * `http://127.0.0.1:4321`, nothing is listening, and the artefact is intact on
 * disk at `runs/<id>/workspace/`. So the field is a historical record of an
 * address that was once live, and a UI that links to it links to nothing.
 * This route is the live address instead, because the dashboard is by definition
 * running when someone is looking at its page.
 *
 * THE SHAPE, AND THE TRAILING SLASH IS LOAD-BEARING:
 *
 *   GET /api/runs/:id/preview/            -> the workspace's index.html
 *   GET /api/runs/:id/preview/styles.css  -> that file, as text/css
 *   GET /api/runs/:id/preview/docs/       -> docs/index.html
 *   GET /api/runs/:id/preview             -> 302 to …/preview/
 *
 * A CLIENT MUST LINK TO THE FORM WITH THE SLASH. Without it the browser resolves
 * `styles.css` in the document against `/api/runs/:id/`, one level too high, and
 * every relative asset 404s — the page renders unstyled and looks like a broken
 * build. The server answers the no-slash form with a 302 rather than trusting
 * every caller to remember, but a link that takes the redirect costs a round trip
 * on every asset-less load and is one refactor away from being emitted into an
 * `<iframe src>` where the redirect is less obvious.
 *
 * WHAT COMES BACK IS BYTES, NOT JSON — that is the whole point, and it is why
 * this section declares no response interface. A REFUSAL, by contrast, is the
 * same {@link ApiErrorResponse} every other route in this API answers with, so a
 * client can render the server's own sentence instead of inventing one.
 *
 * IT IS NOT REDACTED, AND THE CODE BROWSER IS. `GET /api/runs/:id/files` runs
 * `redactForPersistence` over every byte; this route cannot (the high-entropy
 * rule shreds minified JS and inline base64, the self-check's failure mode is to
 * withhold the file, and a PNG is not text). The control that still applies is
 * the NAME rule — `.env`, `.pem`, `id_rsa`, `.git/config` and the rest are
 * refused here exactly as they are refused there. `code-files.ts` note 5 states
 * the same split from the other side.
 *
 * IT IS NOT A SANDBOX. The document is served from the dashboard's OWN origin, so
 * the run's JavaScript runs there. The route sends
 * `connect-src 'none'; form-action 'none'; base-uri 'none'`, which removes the
 * one capability this route creates — fetch/XHR/EventSource/WebSocket and form
 * submission back into this API — and removes nothing else: inline script, inline
 * style and third-party fonts still work, because a preview that cannot render is
 * not a preview. A top-level navigation or a subresource GET to another `/api/`
 * route is still possible; every one of those is read-only and none of them
 * returns a credential value (`sendSecretJson` in `http.ts`).
 * ---------------------------------------------------------------------- */

/**
 * The refusal codes the PREVIEW ROUTE ITSELF authors.
 *
 * DELIBERATELY NOT THE FULL SET, and the name says "own" for that reason. Every
 * other refusal this route can answer with is `code-files.ts`'s — the same
 * `path_escapes_workspace`, `path_forbidden`, `no_workspace`, `not_found`,
 * `invalid_path`, `path_not_relative` and `path_in_bakeoff` that `GET
 * /api/runs/:id/files` answers with, arriving through the same
 * `resolveWorkspacePath`. Those are NOT enumerated here because nothing would
 * keep the enumeration true: `CodeRefusal.code` is a `string`, so a union
 * claiming to list them would be a promise the compiler does not check, which is
 * the exact defect this codebase keeps finding. These three ARE checked — each
 * one is assigned to a `PreviewOwnRefusalCode`-typed const at its single
 * construction site, so renaming the literal or the member fails the build.
 *
 * `no_index_html` — 409. The workspace is real and has no `index.html`. Named
 * rather than 404'd because "the build produced no index.html" is actionable and
 * "not found" is not; the refusal's `remediation` quotes the `.html` files that
 * ARE there, which is what distinguishes a wrongly-named entry point from a build
 * that wrote nothing.
 *
 * `invalid_encoding` — 400. A path segment is not valid percent-encoding
 * (`%zz`). It is a refusal rather than the `URIError` that would otherwise become
 * a 500, because a test asserting "not 200" passes on a crash and proves nothing.
 *
 * `not_a_file` — 403. The resolved path is neither a file nor a directory. The
 * word is shared with the files route on purpose: same condition, same name.
 */
export type PreviewOwnRefusalCode = "no_index_html" | "invalid_encoding" | "not_a_file";
