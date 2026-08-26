import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "./db.js";

const TICKET_SHA = "a".repeat(64);
const SUITE_SHA = "b".repeat(64);
const PAYLOAD_SHA = "c".repeat(64);

test("gate recovery claim is atomic, replay-safe, and never enters the ordinary queue", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-recovery-store-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    store.createRun({
      runId: "source",
      ticketId: "ticket",
      ticketTitle: "Ticket",
      ticketText: "brief",
      ticketSha256: TICKET_SHA,
      modelId: "model",
      provider: "anthropic",
      deploy: false,
      startedAt: "2026-08-26T00:00:00.000Z",
      queuePosition: 1,
    });
    store.updateRun("source", {
      status: "failed",
      phase: "done",
      endedAt: "2026-08-26T01:00:00.000Z",
      heldOutPass: null,
      falseFinish: null,
      agentDeclaredDone: true,
      suiteSha256: SUITE_SHA,
      gateStopReason: "infra",
    });

    const input = {
      sourceRunId: "source",
      clientRequestId: "request-1",
      payloadSha256: PAYLOAD_SHA,
      target: {
        runId: "target",
        ticketId: "ticket",
        ticketTitle: "Ticket — gate recovery",
        ticketText: "brief",
        ticketSha256: TICKET_SHA,
        modelId: "model",
        provider: "anthropic" as const,
        deploy: false,
        startedAt: "2026-08-26T02:00:00.000Z",
        queuePosition: 0,
      },
      targetArtifactPath: join(dir, "target", "workspace"),
      ticketSha256: TICKET_SHA,
      suiteSha256: SUITE_SHA,
      criteria: [{ id: "REQ-001", statement: "the recovery criterion", tier: "BLOCKING" as const }],
      createdAt: "2026-08-26T02:00:00.000Z",
    };
    const first = store.claimGateRecovery(input);
    assert.equal(first.kind, "created");
    assert.equal(first.recovery.state, "prepared");
    assert.equal(first.target.status, "running");
    assert.equal(first.target.phase, "gate");
    assert.equal(first.target.gateAttempts, 0);
    assert.equal(store.listQueued().some((row) => row.runId === "target"), false);
    assert.equal(store.isGateRecoveryTarget("target"), true);

    const replay = store.claimGateRecovery(input);
    assert.equal(replay.kind, "replay");
    const conflict = store.claimGateRecovery({ ...input, payloadSha256: "d".repeat(64) });
    assert.equal(conflict.kind, "conflict");

    assert.notEqual(store.transitionGateRecovery("target", "prepared", "staging", input.createdAt), null);
    assert.notEqual(
      store.transitionGateRecovery("target", "staging", "ready_to_score", input.createdAt, {
        sourceArtifactSha256: "e".repeat(64),
        targetArtifactSha256: "e".repeat(64),
      }),
      null,
    );
    assert.notEqual(store.claimGateRecoveryScoring("target", input.createdAt), null);
    assert.equal(store.claimGateRecoveryScoring("target", input.createdAt), null, "only one scorer owner wins");
    assert.equal(store.getRun("target")?.gateAttempts, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
