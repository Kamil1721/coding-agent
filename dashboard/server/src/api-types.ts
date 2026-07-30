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

/** Providers the dashboard knows about. Mirrors `Provider` in contracts.ts. */
export type ApiProvider = "anthropic" | "openai" | "moonshot" | "deepseek";

/**
 * `included` — covered by a subscription the owner already pays for.
 * `metered`  — billed per token against an API key.
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

export type ApiPhase = "spec" | "build" | "gate" | "judge" | "done";

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

export interface ApiScreenshot {
  readonly path: string;
  readonly label: string;
  readonly capturedAt: string;
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
  readonly screenshots: readonly ApiScreenshot[];
  readonly artifactPath: string | null;
  readonly previewUrl: string | null;
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
  | { readonly type: "rate_limit"; readonly retryAfterSec: number | null }
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

export interface HealthResponse {
  readonly ok: boolean;
  readonly claudeAuth: "ok" | "missing";
  readonly codexAuth: "ok" | "missing";
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
}

export interface CreateRunResponse {
  readonly runId: string;
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
