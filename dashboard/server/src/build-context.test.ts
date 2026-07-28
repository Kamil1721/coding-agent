/**
 * build-context.test.ts — the context instrumentation (Phase 1 Task 7 Step 5).
 *
 * WHAT THIS PROTECTS. A build that touches design, frontend, backend and database
 * is more than one context window holds. When the orchestrator's window fills the
 * SDK compacts it, compaction is lossy, and the orchestrator starts working
 * without decisions it made an hour ago. THE RUN DOES NOT FAIL — it quietly gets
 * worse (spec 15). Nothing in a result record says "this output is no longer
 * trustworthy", so the first bad long build is unexplainable unless the data was
 * captured while it happened.
 *
 * WHY THE LOGIC IS HERE AND NOT IN THE MESSAGE LOOP. `claude-builder.ts`'s own
 * header records being bitten twice by code that could only be REVIEWED, never
 * EXECUTED: its `for await` loop needs a real CLI, which costs subscription
 * quota, so anything written inline there is untested by construction. Task 6 set
 * the precedent with `build-environment.ts`; the reducers and the task->lane
 * bookkeeping live here for the same reason, and the loop keeps one call each.
 *
 * THE ATTRIBUTION PROBLEM, WHICH IS THE ONLY SUBTLE PART. `task_notification` —
 * the message that says a delegated agent finished — carries `task_id` and
 * `status` and NOT `subagent_type`. Only `task_started` carries the agent name,
 * and there it is optional. So a lane boundary is reconstructed by pairing the
 * two, and every test below that names an agent depends on that pairing holding.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONTEXT_FILE,
  LaneWatch,
  appendContextEvent,
  compactionFrom,
  contextSample,
  describeCompaction,
  describeContextSample,
  readContextEvents,
} from "./build-context.js";
import type { ContextUsageEnvelope, LaneBoundary } from "./build-context.js";

/** A context-usage response shaped like the SDK's, with every field overridable. */
function usage(overrides: Partial<ContextUsageEnvelope> = {}): ContextUsageEnvelope {
  return {
    totalTokens: 84_000,
    maxTokens: 200_000,
    percentage: 42,
    model: "claude-opus-5",
    categories: [
      { name: "System prompt", tokens: 4_000 },
      { name: "Messages", tokens: 70_000 },
      { name: "Tools", tokens: 10_000 },
    ],
    ...overrides,
  };
}

function boundary(overrides: Partial<LaneBoundary> = {}): LaneBoundary {
  return { taskId: "t1", agent: "code-reviewer", lane: "review", status: "completed", ...overrides };
}

test("a closing agent is attributed to its lane by pairing the two task messages", () => {
  const watch = new LaneWatch();
  watch.started({ task_id: "t1", subagent_type: "code-reviewer" });
  assert.deepEqual(watch.closed({ task_id: "t1", status: "completed" }), {
    taskId: "t1",
    agent: "code-reviewer",
    lane: "review",
    status: "completed",
  });
});

test("a task the CLI gave no subagent_type is not sampled at all", () => {
  // `subagent_type` is OPTIONAL in the SDK's typing, and ambient/housekeeping
  // tasks have none. A task with no agent has no lane, and inventing one would
  // put a wrong label on a number that is only useful if it is trusted.
  const watch = new LaneWatch();
  watch.started({ task_id: "t1" });
  assert.equal(watch.closed({ task_id: "t1", status: "completed" }), null);
});

test("a notification for a task nobody saw start closes nothing", () => {
  // A resumed session replays nothing, so the first message about a task can be
  // its completion. Better no sample than one attributed by guesswork.
  assert.equal(new LaneWatch().closed({ task_id: "ghost", status: "completed" }), null);
});

test("a lane with another agent still running is NOT a boundary yet", () => {
  // REVIEW runs fully parallel (spec 6.4). Sampling as each one finishes would
  // measure the same lane three times and call two of them boundaries.
  const watch = new LaneWatch();
  watch.started({ task_id: "t1", subagent_type: "code-reviewer" });
  watch.started({ task_id: "t2", subagent_type: "security-auditor" });
  assert.equal(watch.closed({ task_id: "t1", status: "completed" }), null);
  assert.equal(watch.closed({ task_id: "t2", status: "completed" })?.agent, "security-auditor");
});

test("another lane running does not stop this one from closing", () => {
  const watch = new LaneWatch();
  watch.started({ task_id: "b1", subagent_type: "backend-developer" });
  watch.started({ task_id: "r1", subagent_type: "code-reviewer" });
  assert.equal(watch.closed({ task_id: "r1", status: "completed" })?.lane, "review");
});

test("a failed or stopped agent still closes its lane — that is when the number matters most", () => {
  // A lane that failed is exactly the run you come back to explain later.
  for (const status of ["failed", "stopped"]) {
    const watch = new LaneWatch();
    watch.started({ task_id: "t1", subagent_type: "debugger" });
    assert.equal(watch.closed({ task_id: "t1", status })?.status, status);
  }
});

test("an agent in no lane is still tracked, under its own name", () => {
  // `allowedAgents` is a plain array and nothing requires its members to be in
  // DELIVERY_LANES. An unplaced agent gets `lane: null` and its own bucket, so it
  // neither loses its sample nor holds another lane open.
  const watch = new LaneWatch();
  watch.started({ task_id: "t1", subagent_type: "some-future-agent" });
  watch.started({ task_id: "t2", subagent_type: "code-reviewer" });
  const closed = watch.closed({ task_id: "t2", status: "completed" });
  assert.equal(closed?.lane, "review", "an unplaced agent must not hold REVIEW open");
  assert.equal(watch.closed({ task_id: "t1", status: "completed" })?.lane, null);
});

test("the same task cannot close twice", () => {
  const watch = new LaneWatch();
  watch.started({ task_id: "t1", subagent_type: "debugger" });
  assert.ok(watch.closed({ task_id: "t1", status: "completed" }) !== null);
  assert.equal(watch.closed({ task_id: "t1", status: "completed" }), null);
});

test("the sample keeps the token counts and drops the terminal rendering", () => {
  // `getContextUsage()` answers with `gridRows` (coloured squares for a TUI),
  // `memoryFiles` (absolute home-directory paths) and `mcpTools`. None of that is
  // evidence about a degraded run, and the same discipline that kept `tools` out
  // of the environment hash keeps it out of here.
  const sample = contextSample(boundary(), usage());
  assert.equal(sample.totalTokens, 84_000);
  assert.equal(sample.maxTokens, 200_000);
  assert.equal(sample.percentage, 42);
  assert.equal(sample.agent, "code-reviewer");
  assert.equal(sample.lane, "review");
  assert.deepEqual(
    sample.categories.map((c) => c.name),
    ["System prompt", "Messages", "Tools"],
  );
  assert.equal("gridRows" in sample, false);
  assert.equal("memoryFiles" in sample, false);
  // It goes to disk through JSON, so it must survive the trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(sample)), sample);
});

test("a CLI that omits a category list gives an empty one, not a crash", () => {
  const sample = contextSample(boundary(), { totalTokens: 10, maxTokens: 20, percentage: 50 });
  assert.deepEqual(sample.categories, []);
  assert.equal(sample.model, "");
});

test("a compaction records what it cost, because that IS the explanation", () => {
  const record = compactionFrom({
    compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 60_000, duration_ms: 4_200 },
  });
  assert.equal(record.trigger, "auto");
  assert.equal(record.preTokens, 180_000);
  assert.equal(record.postTokens, 60_000);
  assert.equal(record.durationMs, 4_200);
});

test("a compaction with no post-count is recorded as unknown, not as zero", () => {
  // `post_tokens` and `duration_ms` are OPTIONAL in the SDK's typing. Zero would
  // read as "it compacted to nothing", which is a claim the message never made.
  const record = compactionFrom({ compact_metadata: { trigger: "manual", pre_tokens: 120_000 } });
  assert.equal(record.postTokens, null);
  assert.equal(record.durationMs, null);
});

test("events APPEND — a run compacts more than once and each time is evidence", () => {
  // The environment record is written once and overwritten; this one is not. A
  // second sample that replaced the first would leave a file that says a long run
  // sampled its context exactly once.
  const dir = mkdtempSync(join(tmpdir(), "dash-ctx-"));
  try {
    appendContextEvent(dir, contextSample(boundary(), usage()));
    appendContextEvent(dir, contextSample(boundary({ taskId: "t2", agent: "debugger", lane: "gate" }), usage()));
    const file = appendContextEvent(
      dir,
      compactionFrom({ compact_metadata: { trigger: "auto", pre_tokens: 9 } }),
    );
    assert.equal(file, join(dir, CONTEXT_FILE));

    const events = readContextEvents(dir);
    assert.equal(events.length, 3, "three events, three lines");
    assert.deepEqual(
      events.map((e) => e.kind),
      ["context_usage", "context_usage", "compaction"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted event goes through the redaction chokepoint", () => {
  // Category names are CLI-reported rather than owner-typed, so nothing here is
  // EXPECTED to carry a credential — which is exactly the reasoning that puts a
  // writer outside the chokepoint, and is why this one goes through it anyway.
  const dir = mkdtempSync(join(tmpdir(), "dash-ctx-"));
  try {
    const fakeKey = `sk-ant-api03-${"A1b2C3d4E5f6G7h8".repeat(6)}`;
    const file = appendContextEvent(
      dir,
      contextSample(boundary(), usage({ categories: [{ name: `leaky ${fakeKey}`, tokens: 1 }] })),
    );
    assert.equal(readFileSync(file, "utf8").includes(fakeKey), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log line says how full the window is and who just finished", () => {
  const line = describeContextSample(contextSample(boundary(), usage()));
  assert.match(line, /42/, "the percentage is the number a human acts on");
  assert.match(line, /code-reviewer/);
  assert.match(line, /review/);
});

test("a compaction reads as a warning about the output, not as a statistic", () => {
  const line = describeCompaction(
    compactionFrom({ compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 60_000 } }),
  );
  assert.match(line, /compact/i);
  assert.match(line, /180000|180,000/);
  // The whole point of surfacing it: a compaction is the best single explanation
  // for a run that produced mediocre output, and a bare number does not say so.
  assert.match(line, /earlier|forget|lost|summaris|summariz/i);
});
