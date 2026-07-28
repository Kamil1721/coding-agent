/**
 * build-context.ts — how much of the orchestrator's context window is left, and
 * when it was thrown away.
 *
 * THE FAILURE THIS FILE EXISTS TO MAKE VISIBLE. A portfolio build touches design,
 * frontend, backend and database. In one session that is more than any context
 * window holds. When it fills, the SDK compacts — which is lossy — and the
 * orchestrator starts working without decisions it made an hour ago. THE RUN DOES
 * NOT FAIL. It quietly gets worse (spec 15). A pipeline that degrades silently is
 * worse than one that stops, because nothing tells you the output stopped being
 * trustworthy, and by the time a human notices, the evidence — a message that
 * appeared once, in a stream nobody kept — is gone.
 *
 * DELEGATION IS THE MITIGATION, AND THIS IS THE MEASUREMENT OF IT. A subagent
 * runs in its own context window: fifty tool calls inside it cost the parent only
 * the report that comes back, which is roughly 50:1 and the entire reason a build
 * this size fits (spec 15.1). `build-prompt.ts` states the report contract that
 * keeps that ratio. Nothing here enforces it — this file records what actually
 * happened, so the next long build is explainable rather than a mystery.
 *
 * WHY THE LOGIC IS HERE AND NOT IN THE MESSAGE LOOP. `builders/claude-builder.ts`
 * records being bitten twice by code that could only be REVIEWED: its `for await`
 * loop needs a real CLI, so anything written inline there is untested by
 * construction. Task 6 set the precedent with `build-environment.ts`. Everything
 * below is a pure transform or a bounded append, unit-tested without a token of
 * quota; the loop keeps one call each.
 *
 * WHAT IS SAMPLED, AND WHAT IS DELIBERATELY NOT. `Query.getContextUsage()`
 * answers with `gridRows` (coloured squares for a terminal), `memoryFiles`
 * (absolute home-directory paths), `mcpTools` and `rawMaxTokens`. None of that is
 * evidence about a degraded run and `gridRows` is several hundred objects of
 * rendering state. The same discipline that kept `tools[]` out of the environment
 * hash keeps them out of here: what is persisted is the totals and the per
 * -category token counts.
 *
 * SAMPLED AT LANE BOUNDARIES, NOT POLLED. A number taken at "BUILD went quiet" is
 * interpretable — it says what BUILD cost. A number taken every thirty seconds
 * says the same thing less clearly and adds a control round-trip to a session
 * whose turn budget is the scarce resource. Spec 15.4 asks for the boundary.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import { laneOf } from "./agent-shortlist.js";
import type { Lane } from "./agent-shortlist.js";

/**
 * The shape of `SDKTaskStartedMessage`, as far as this file cares.
 *
 * STRUCTURAL, like `InitEnvelope`: a real SDK message satisfies it (required
 * fields are assignable to optional ones) and a CLI that stops sending a field
 * degrades to "not attributable" instead of taking the run down while trying to
 * INSTRUMENT it.
 *
 * `subagent_type` IS OPTIONAL IN THE SDK'S OWN TYPING, and that is load-bearing
 * rather than defensive: ambient/housekeeping tasks carry none, and this is the
 * ONLY message that carries it at all.
 */
export interface TaskStartedEnvelope {
  readonly task_id: string;
  readonly subagent_type?: string;
}

/**
 * The shape of `SDKTaskNotificationMessage`.
 *
 * NOTE WHAT IS ABSENT: no `subagent_type`. The message that says an agent
 * FINISHED does not say which agent it was, which is why {@link LaneWatch} pairs
 * it with the start message rather than reading a lane straight off it.
 */
export interface TaskNotificationEnvelope {
  readonly task_id: string;
  /** The CLI's own word: `completed`, `failed` or `stopped`. */
  readonly status: string;
}

/** A delegated agent finished and its lane went quiet with it. */
export interface LaneBoundary {
  readonly taskId: string;
  readonly agent: string;
  /** Null for an agent in no lane — never a guess. See {@link laneOf}. */
  readonly lane: Lane | null;
  readonly status: string;
}

/**
 * Which lane an in-flight task belongs to, for the "is this lane still busy?"
 * question.
 *
 * An agent in no lane gets a bucket of its own rather than sharing one with every
 * other unplaced agent: two unrelated future agents running at once must not hold
 * each other's boundary open, and neither may hold a real lane's.
 */
function bucketOf(agent: string, lane: Lane | null): string {
  return lane ?? `agent:${agent}`;
}

/**
 * Which delegated agents are in flight, and therefore when a lane goes quiet.
 *
 * "THE LANE'S LAST AGENT" IS NOT KNOWABLE IN ADVANCE, and this class does not
 * pretend otherwise. Nothing in the stream says how many agents a lane will run —
 * the orchestrator decides that as it goes. The only observable definition is
 * "this completion leaves no other in-flight task in the same lane", which is
 * what is implemented. The consequence, stated rather than glossed: for a
 * PARALLEL lane (REVIEW, spec 6.4) that fires once, when the last lens returns;
 * for a SEQUENTIAL lane (GATE/FIX) it fires once per agent, because each one is
 * alone in its lane while it runs. Samples are cheap and a per-agent sample is
 * still a true statement about the context at that moment, so the over-sampling
 * is accepted rather than papered over with a guess about lane size.
 */
export class LaneWatch {
  readonly #open = new Map<string, { readonly agent: string; readonly bucket: string }>();

  /**
   * Start tracking a delegated task.
   *
   * A task with no `subagent_type` is IGNORED, not tracked under a placeholder.
   * It has no agent, so it can have no lane, and a sample labelled with an
   * invented lane is worse than no sample: it reads as evidence.
   */
  started(message: TaskStartedEnvelope): void {
    const agent = message.subagent_type;
    if (agent === undefined || agent.length === 0) return;
    this.#open.set(message.task_id, { agent, bucket: bucketOf(agent, laneOf(agent)) });
  }

  /**
   * Close a task, and answer with the lane boundary it created — or null when it
   * created none.
   *
   * Null in three cases, all of them ordinary: the task was never tracked (an
   * ambient task, or one that started before this watch existed — a resumed
   * session replays nothing), the same notification arrived twice, or another
   * agent of the same lane is still running.
   */
  closed(message: TaskNotificationEnvelope): LaneBoundary | null {
    const open = this.#open.get(message.task_id);
    if (open === undefined) return null;
    this.#open.delete(message.task_id);
    for (const other of this.#open.values()) {
      if (other.bucket === open.bucket) return null;
    }
    return {
      taskId: message.task_id,
      agent: open.agent,
      lane: laneOf(open.agent),
      status: message.status,
    };
  }
}

/** One category of the context window, as the CLI counts it. */
export interface ContextCategory {
  readonly name: string;
  readonly tokens: number;
}

/**
 * The shape of `SDKControlGetContextUsageResponse`, as far as this file cares.
 * The real response carries more; see the header for what is dropped and why.
 */
export interface ContextUsageEnvelope {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
  readonly model?: string;
  readonly categories?: readonly ContextCategory[];
}

/** One reading of the context window, taken because a lane went quiet. */
export interface ContextSample {
  /** Discriminates the two event shapes on one JSONL file. */
  readonly kind: "context_usage";
  readonly taskId: string;
  readonly agent: string;
  readonly lane: Lane | null;
  readonly status: string;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
  readonly model: string;
  readonly categories: readonly ContextCategory[];
}

/**
 * Reduce a usage response to the part that explains a run.
 *
 * Every field is REQUIRED and defaults, exactly as `RunEnvironment` does, so a
 * reader never distinguishes "the CLI sent no categories" from "we forgot to
 * record them", and `exactOptionalPropertyTypes` never enters the picture.
 */
export function contextSample(boundary: LaneBoundary, usage: ContextUsageEnvelope): ContextSample {
  return {
    kind: "context_usage",
    taskId: boundary.taskId,
    agent: boundary.agent,
    lane: boundary.lane,
    status: boundary.status,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    model: usage.model ?? "",
    categories: (usage.categories ?? []).map((c) => ({ name: c.name, tokens: c.tokens })),
  };
}

/** The shape of `SDKCompactBoundaryMessage`, as far as this file cares. */
export interface CompactBoundaryEnvelope {
  readonly compact_metadata: {
    readonly trigger: string;
    readonly pre_tokens: number;
    readonly post_tokens?: number;
    readonly duration_ms?: number;
  };
}

/** The context window was summarised to make room. Detail was lost. */
export interface CompactionRecord {
  readonly kind: "compaction";
  /** `auto` (the window filled) or `manual`. */
  readonly trigger: string;
  readonly preTokens: number;
  /** Null when the CLI did not say — NOT zero, which would be a claim. */
  readonly postTokens: number | null;
  readonly durationMs: number | null;
}

/**
 * Capture a compaction.
 *
 * `post_tokens` and `duration_ms` are optional in the SDK's typing and are
 * recorded as null rather than 0 when absent. Zero would read as "it compacted to
 * nothing", which is a statement the message never made — the same failure as an
 * environment hash that looks like a hash and distinguishes nothing.
 */
export function compactionFrom(message: CompactBoundaryEnvelope): CompactionRecord {
  const meta = message.compact_metadata;
  return {
    kind: "compaction",
    trigger: meta.trigger,
    preTokens: meta.pre_tokens,
    postTokens: meta.post_tokens ?? null,
    durationMs: meta.duration_ms ?? null,
  };
}

/** Either thing worth knowing about a run's context, on one timeline. */
export type ContextEvent = ContextSample | CompactionRecord;

/** The file these land in, inside the run's own results directory. */
export const CONTEXT_FILE = "context.jsonl";

/**
 * Append one event to the run's context timeline, and return where it went.
 *
 * JSONL AND APPEND, WHERE THE ENVIRONMENT RECORD IS JSON AND OVERWRITE. The
 * environment is one statement made once, at init. This is a SERIES: a long build
 * samples at every lane boundary and may compact repeatedly, and each occurrence
 * is separate evidence. A writer that overwrote would leave a file saying a
 * four-hour build measured its context exactly once — which looks like a working
 * record. `ledger.jsonl` in the same directory is the existing precedent.
 *
 * REDACTED, like every other persisted string in this program. Nothing here is
 * EXPECTED to carry a credential — category names are CLI-reported, not
 * owner-typed — and that is exactly the reasoning that puts a writer outside the
 * chokepoint, so this one goes through it anyway.
 *
 * IT LIVES HERE, NOT IN THE ORCHESTRATOR, so it can be EXECUTED by a test rather
 * than reviewed inside a private method that only a real build reaches.
 */
export function appendContextEvent(resultsDir: string, event: ContextEvent): string {
  const file = join(resultsDir, CONTEXT_FILE);
  appendFileSync(file, `${JSON.stringify(redactForPersistence(event))}\n`, "utf8");
  return file;
}

/**
 * Read a run's context timeline back.
 *
 * Exists so the append above is checked by reading what a later reader would
 * actually read, rather than by asserting on the string that was written. A
 * malformed line is skipped instead of throwing: this is a record of a run, and
 * one truncated line — the ordinary result of a process killed mid-write — must
 * not make the other twenty unreadable.
 */
export function readContextEvents(resultsDir: string): readonly ContextEvent[] {
  let raw: string;
  try {
    raw = readFileSync(join(resultsDir, CONTEXT_FILE), "utf8");
  } catch {
    return [];
  }
  const events: ContextEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as ContextEvent);
    } catch {
      /* a torn line is skipped, not fatal */
    }
  }
  return events;
}

/** `84,000` — grouped, because six-digit token counts are misread ungrouped. */
function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The one line a human sees when a lane closes.
 *
 * The PERCENTAGE leads because it is the number anyone acts on; the lane and
 * agent follow, because "75% after BUILD" and "75% after SPEC" mean opposite
 * things about the rest of the run.
 */
export function describeContextSample(sample: ContextSample): string {
  const who = sample.lane === null ? sample.agent : `${sample.lane}/${sample.agent}`;
  return (
    `context — ${String(Math.round(sample.percentage))}% used ` +
    `(${grouped(sample.totalTokens)}/${grouped(sample.maxTokens)} tokens) ` +
    `after ${who} ${sample.status}`
  );
}

/**
 * The one line a human sees when the window is summarised.
 *
 * IT SAYS WHAT IT MEANS, not just what it measured. A bare "compacted: 180000 ->
 * 60000" reads as a statistic; the reason this event is surfaced at all is that
 * it is the best single explanation for a run that produced mediocre output, and
 * a reader three days later needs the sentence, not the arithmetic.
 */
export function describeCompaction(record: CompactionRecord): string {
  const after = record.postTokens === null ? "unknown" : `${grouped(record.postTokens)} tokens`;
  return (
    `context COMPACTED (${record.trigger}) — ${grouped(record.preTokens)} tokens before, ` +
    `${after} after. Compaction is lossy: earlier decisions may have been summarised away, ` +
    `and output after this point is less reliable than output before it.`
  );
}
