/**
 * orchestrator.defect-record.test.ts — the two records a dead run must leave
 * behind, written by a run that really dies.
 *
 * ═══ WHY IT DRIVES A REAL RUN ═══
 *
 * `orchestrator.spec-spend.test.ts` records the lesson this file inherits: the
 * ledger fixtures in `orchestrator.test.ts` pre-freeze a suite, so `#specPhase`
 * returns at its reuse branch and the authoring path is never entered — a
 * mutation proof passed with the production path unreachable. So this file
 * freezes nothing, spends nothing (the SDK's `query` is replaced with a factory
 * that answers in prose carrying no JSON), and lets the run die in `spec` for
 * real, exactly as `a913c871` did.
 *
 * ═══ WHAT IT PINS ═══
 *
 *   1. `results/defect.json` exists after a terminal transition, and its
 *      signature is a 64-char hex digest — because it is also a filename.
 *   2. `data/defects/<signature>.jsonl` is APPENDED, so a second occurrence of
 *      the same class does not erase the first.
 *   3. Fields that are unavailable say so. `violations: []` on a run whose
 *      violations never travelled would read as "the classifier looked and found
 *      none", and that is the defect this repository keeps shipping.
 *   4. `results/authoring-trail.json` exists ON THE FAILURE PATH — the path that
 *      wrote nothing at all until today, and the reason `a913c871`'s three
 *      attempts had to be recovered from CLI session transcripts.
 *
 * ═══ NEGATIVE CONTROLS — applied to production code, compiled, run, watched
 *     RED, reverted (2026-08-10). Verbatim first line of each RED is quoted at
 *     the assertion it broke. ═══
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore, isTerminal } from "./db.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { isRepairable } from "./recovery.js";
import type { FailureClass } from "./recovery.js";
import type { SeatSessionFactory } from "./subscription-caller.js";

const TICKET_TEXT =
  "Build a page that lists three projects, each with a title and a one-line summary. " +
  "Store nothing; there is no database and no API.";

const USAGE = {
  input_tokens: 11,
  output_tokens: 222,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 5,
};

function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

function unparseable(): SeatSessionFactory {
  return ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => {
    void prompt;
    void options;
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      yield envelope({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "I would rather describe it." }] },
      });
      yield envelope({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "I would rather describe it.",
        usage: USAGE,
      });
    })();
  };
}

interface DeadRun {
  readonly store: RunStore;
  readonly home: string;
  readonly resultsDir: string;
  readonly defectsDir: string;
  readonly settled: readonly string[];
  readonly cleanup: () => void;
}

/** One run, driven to a real death in the spec phase, in its own DASHBOARD_HOME. */
async function deadSpecRun(runId: string, home?: string): Promise<DeadRun> {
  const dir = home ?? mkdtempSync(join(tmpdir(), "dash-defect-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const settled: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: { HOME: dir, PATH: "" },
    seatQuery: unparseable(),
    onRunSettled: (id) => settled.push(id),
  });

  store.createRun({
    runId,
    ticketId: "seeded-at-create",
    ticketTitle: "Three projects",
    ticketText: TICKET_TEXT,
    ticketSha256: "c".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    interactive: false,
  });

  orchestrator.pump();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = store.getRun(runId);
    if (row !== null && isTerminal(row.status)) break;
    if (Date.now() > deadline) throw new Error("the run never reached a terminal status");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await orchestrator.shutdown();

  return {
    store,
    home: dir,
    resultsDir: join(paths.runs, runId, "results"),
    defectsDir: join(paths.data, "defects"),
    settled,
    cleanup: () => {
      store.close();
      if (home === undefined) rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a dead run writes a defect record, and the record says what it does not know", async () => {
  const run = await deadSpecRun("run-defect-1");
  try {
    const recordPath = join(run.resultsDir, "defect.json");
    // MUTATION: delete the `this.#writeDefectRecord(...)` call from `#finish`.
    //   VERBATIM RED:
    //   AssertionError [ERR_ASSERTION]: the terminal transition must write …/results/defect.json
    assert.ok(existsSync(recordPath), `the terminal transition must write ${recordPath}`);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;

    assert.equal(record["runId"], "run-defect-1");
    assert.equal(record["status"], "failed");
    assert.equal(record["phase"], "spec");
    assert.match(String(record["signature"]), /^[0-9a-f]{64}$/, "the signature is also a filename");
    assert.notEqual(String(record["failureClass"]), "");

    /*
     * ═══ `repairable` IS NOW `true` HERE, AND THE CHANGE IS THE FIX, NOT A
     *     RELAXATION (2026-08-10) ═══
     *
     * This assertion used to read `false`, justified as "a class with a zero bound
     * is not repairable in-run", because `#writeDefectRecord` derived the field as
     * `boundFor(failureClass) > 0`. Every class `classOfBakeoffCode` can return is
     * bound 0, so the field was provably `false` for all twelve `BakeoffError`
     * codes — while `supervisor.ts` put this very ticket into the state `repairing`,
     * whose own sentence is "waiting for a repair proposal for this failure class".
     * The fingerprint record and the panel above it disagreed about the same
     * failure, and both were shown to the owner.
     *
     * `boundFor(...) > 0` answers "may this run re-enter the phase BY ITSELF",
     * which is a retry-budget question. `isRepairable` answers "may an agent
     * propose a patch for this class", which is what the field is named after and
     * what the supervisor was already deciding by hand. The record now reads the
     * same function the supervisor reads.
     *
     * ASSERTED AGAINST THE SHARED PREDICATE, NOT AGAINST A LITERAL, so a revert to
     * `boundFor(...) > 0` cannot pass: it would make this `false` while
     * `isRepairable("suite_authoring")` stays `true`. The literal is asserted too,
     * so the pair cannot both drift in the same direction unnoticed.
     */
    assert.equal(
      record["failureClass"],
      "suite_authoring",
      "this run dies on a seat that answers in prose, which is `suite_not_audited` — if the class " +
        "moved, the repairability assertions below are about a different failure",
    );
    assert.equal(
      record["repairable"],
      true,
      "the defect record says no agent may propose a repair for a suite-authoring failure, while " +
        "`supervisor.ts` puts the same ticket into `repairing`. That disagreement reached the owner.",
    );
    assert.equal(
      record["repairable"],
      isRepairable(String(record["failureClass"]) as FailureClass),
      "the record's `repairable` is not the shared predicate's answer for its own class, so the " +
        "record and the supervisor can disagree again",
    );

    // ABSENCE IS NOT EMPTINESS. Nothing structured travels on this failure yet,
    // and the record must say so rather than report zero violations.
    // MUTATION: make `buildDefectRecord` treat `violations: null` as `[]` (drop
    // the `violationsAvailable` flag and the `unavailable` sentence).
    //   VERBATIM RED:
    //   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false
    assert.equal(record["violationsAvailable"], false);
    assert.ok(Array.isArray(record["unavailable"]) && (record["unavailable"] as unknown[]).length > 0);
    assert.ok(
      (record["unavailable"] as string[]).some((line) => line.includes("violations:")),
      "the unavailable list must name the field that is unknown",
    );
    // The failure text is CARRIED, never parsed — but it must be there for a human.
    assert.ok(String(record["failureReason"] ?? "").length > 0);

    // The shard is content-addressed and was appended to.
    const shard = join(run.defectsDir, `${String(record["signature"])}.jsonl`);
    assert.ok(existsSync(shard), `${shard} must exist`);
    assert.equal(readFileSync(shard, "utf8").trimEnd().split("\n").length, 1);

    // And the settle hook fired exactly once, after everything above was durable.
    assert.deepEqual(run.settled, ["run-defect-1"]);
  } finally {
    run.cleanup();
  }
});

test("a second run of the same class APPENDS to the shard rather than replacing it", async () => {
  const first = await deadSpecRun("run-defect-a");
  try {
    const signature = String(
      (JSON.parse(readFileSync(join(first.resultsDir, "defect.json"), "utf8")) as Record<string, unknown>)["signature"],
    );
    first.store.close();
    const second = await deadSpecRun("run-defect-b", first.home);
    const shard = join(second.defectsDir, `${signature}.jsonl`);
    // MUTATION: use `writeFileSync` instead of `appendFileSync` in
    // `writeDefectRecord` and the first occurrence is erased by the second.
    //   VERBATIM RED:
    //   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2
    assert.equal(readFileSync(shard, "utf8").trimEnd().split("\n").length, 2);
    const lines = readFileSync(shard, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as Record<string, unknown>)["runId"]);
    assert.deepEqual(lines, ["run-defect-a", "run-defect-b"]);
    second.cleanup();
  } finally {
    rmSync(first.home, { recursive: true, force: true });
  }
});

test("the authoring trail is written on the FAILURE path, and admits what it could not read", async () => {
  const run = await deadSpecRun("run-trail-1");
  try {
    const trailPath = join(run.resultsDir, "authoring-trail.json");
    // MUTATION: delete `this.#writeAuthoringTrail(...)` from `#specPhase`'s
    // `finally` — i.e. restore the behaviour that made `a913c871` unlearnable.
    //   VERBATIM RED:
    //   AssertionError [ERR_ASSERTION]: the spec phase must leave a trail even when it dies: …
    assert.ok(existsSync(trailPath), `the spec phase must leave a trail even when it dies: ${trailPath}`);
    const trail = JSON.parse(readFileSync(trailPath, "utf8")) as Record<string, unknown>;
    assert.equal(trail["outcome"], "failed");
    assert.equal(trail["suiteSha256"], null);
    // TODAY the attempts do not travel on the thrown error, so the trail must
    // say UNAVAILABLE rather than report an empty list as a measurement. When
    // the digest-moving §8.0a change lands, this flips to true and the
    // assertion below is the thing that will notice.
    assert.equal(trail["attemptsAvailable"], false);
    assert.ok(String(trail["source"]).startsWith("UNAVAILABLE"), String(trail["source"]));
    assert.deepEqual(trail["attempts"], []);
    // The run's own log says it, so the owner does not have to find the file.
    const logs = run.store
      .eventsSince("run-trail-1", 0)
      .map((row) => row.event as unknown as Record<string, unknown>)
      .filter((event) => event["type"] === "log")
      .map((event) => String(event["text"] ?? ""));
    assert.ok(
      logs.some((line) => line.startsWith("authoring trail —")),
      "the trail must be announced on the run's own stream",
    );
    assert.ok(logs.some((line) => line.startsWith("defect record ")));
  } finally {
    run.cleanup();
  }
});
