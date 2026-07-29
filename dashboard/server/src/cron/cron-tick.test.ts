/**
 * cron-tick.test.ts — THE TRAP, made observable.
 *
 * Six of the seven ways a tick can end look identical from outside: no new run
 * appeared. These tests are what makes them different from inside. NOTHING here
 * reaches a network, spawns a process, opens a database or constructs an
 * `Orchestrator`: `http` is injected in every scenario and the clock is fixed.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelOption, RunSummary } from "../api-types.js";
import type { CronDecision } from "./cron-journal.js";
import { appendIntent, appendOutcome, orphanIntents, readJournal } from "./cron-journal.js";
import { CRON_LEASE_FILE, acquireLease } from "./cron-lease.js";
import { CRON_DIRS, listQueue, strandedClaims } from "./cron-queue.js";
import { EXIT, newTickId, runTick } from "./cron-tick.js";
import type { TickDeps, TickResponse, TickResult } from "./cron-tick.js";

const NOW = "2026-07-30T02:00:00.000Z";
const MODEL = "opus[1m]";
const TICKET = "build me a thing";

type Spec = "throw" | { readonly status: number; readonly body: unknown };

const OK_MODEL: ModelOption = {
  id: MODEL,
  label: "Opus",
  provider: "anthropic",
  tier: "included",
  available: true,
  reason: null,
};

interface Scenario {
  readonly name: string;
  readonly tickId?: string;
  readonly queue?: readonly string[];
  readonly claimed?: readonly string[];
  readonly liveLease?: string;
  readonly seedIntents?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly health?: Spec;
  readonly models?: Spec;
  readonly runs?: Spec;
  readonly create?: Spec;
  readonly expect: CronDecision;
}

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string> | undefined;
  readonly body: string | undefined;
}

function route(spec: Spec): TickResponse {
  if (spec === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:4176");
  return { status: spec.status, text: async () => JSON.stringify(spec.body) };
}

async function runScenario(
  scenario: Scenario,
): Promise<{ root: string; result: TickResult; requests: readonly Recorded[] }> {
  const root = join(mkdtempSync(join(tmpdir(), "cron-tick-")), "cron");
  mkdirSync(join(root, CRON_DIRS.queue), { recursive: true });
  mkdirSync(join(root, CRON_DIRS.claimed), { recursive: true });
  for (const name of scenario.queue ?? ["a.md"]) {
    writeFileSync(join(root, CRON_DIRS.queue, name), TICKET, "utf8");
  }
  for (const name of scenario.claimed ?? []) {
    writeFileSync(join(root, CRON_DIRS.claimed, name), TICKET, "utf8");
  }
  if (scenario.liveLease !== undefined) {
    writeFileSync(
      join(root, CRON_LEASE_FILE),
      `${JSON.stringify({ tickId: scenario.liveLease, pid: 4242, at: NOW })}\n`,
      "utf8",
    );
  }
  for (let index = 0; index < (scenario.seedIntents ?? 0); index += 1) {
    const base = { dashboardUrl: "http://127.0.0.1:4176", modelId: MODEL, tickId: `seed-${String(index)}`, at: NOW };
    appendIntent(root, { ...base, reason: "seeded", ticketFile: "/q/seed.md" });
    appendOutcome(root, {
      ...base,
      decision: "submitted",
      reason: "seeded",
      ticketFile: "/q/seed.md",
      runId: `run-seed-${String(index)}`,
      exitCode: 0,
    });
  }

  const requests: Recorded[] = [];
  const deps: TickDeps = {
    env: { DASHBOARD_CRON_DIR: root, DASHBOARD_CRON_MODEL: MODEL, ...scenario.env },
    now: () => NOW,
    tickId: scenario.tickId ?? "t1",
    isAlive: () => true,
    http: async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url, method, headers: init?.headers, body: init?.body });
      if (url.endsWith("/api/health")) {
        return route(scenario.health ?? { status: 200, body: { ok: true, claudeAuth: "ok", codexAuth: "missing" } });
      }
      if (url.endsWith("/api/models")) return route(scenario.models ?? { status: 200, body: [OK_MODEL] });
      if (url.endsWith("/api/runs") && method === "GET") {
        return route(scenario.runs ?? { status: 200, body: [] as readonly RunSummary[] });
      }
      if (url.endsWith("/api/runs")) return route(scenario.create ?? { status: 201, body: { runId: "run-x" } });
      throw new Error(`unscripted request: ${method} ${url}`);
    },
  };
  return { root, result: await runTick(deps), requests };
}

/** ONE PER DECISION. The trap test below asserts all eight leave exactly one row. */
const ALL_SCENARIOS: readonly Scenario[] = [
  { name: "submitted", tickId: "s-submitted", expect: "submitted" },
  { name: "skipped (nothing queued)", tickId: "s-skipped", queue: [], expect: "skipped" },
  { name: "refused (ceiling spent)", tickId: "s-refused", seedIntents: 4, expect: "refused" },
  { name: "lease-held", tickId: "s-lease", liveLease: "other-tick", expect: "lease-held" },
  { name: "stranded", tickId: "s-stranded", claimed: ["dead-tick-a.md"], expect: "stranded" },
  {
    name: "misconfigured (no model)",
    tickId: "s-misconfigured",
    env: { DASHBOARD_CRON_MODEL: "" },
    expect: "misconfigured",
  },
  { name: "unreachable (dashboard down)", tickId: "s-unreachable", health: "throw", expect: "unreachable" },
  {
    name: "rejected (400)",
    tickId: "s-rejected",
    create: { status: 400, body: { error: "invalid_ticket", message: "no", remediation: null } },
    expect: "rejected",
  },
];

test("THE TRAP: every decision leaves exactly one recorded outcome and a distinct exit", async () => {
  // Six of the seven ways a tick ends look identical from outside — "no new run
  // appeared". This is the test that makes them different from inside.
  for (const scenario of ALL_SCENARIOS) {
    const { root, result } = await runScenario(scenario);
    const { rows, unreadableLines } = readJournal(root);
    const tickId = scenario.tickId ?? "t1";
    const outcomes = rows.filter((row) => row.phase === "outcome" && row.tickId === tickId);
    assert.equal(outcomes.length, 1, `${scenario.name} left ${String(outcomes.length)} outcome rows`);
    assert.equal(outcomes[0]?.decision, scenario.expect, scenario.name);
    assert.equal(result.decision, scenario.expect, scenario.name);
    assert.equal(result.exitCode, EXIT[scenario.expect], scenario.name);
    assert.ok((outcomes[0]?.reason ?? "").length > 0, `${scenario.name}: a decision with no reason is unactionable`);
    assert.equal(unreadableLines, 0, scenario.name);
  }
});

test("exit codes are DISTINCT per decision, and only the two no-ops are zero", () => {
  const nonZero = (["misconfigured", "lease-held", "stranded", "unreachable", "rejected", "refused"] as const).map(
    (decision) => EXIT[decision],
  );
  assert.equal(new Set(nonZero).size, nonZero.length, "two faults sharing an exit code are one fault in launchd's log");
  assert.equal(new Set(Object.values(EXIT)).size, 7, "8 decisions, 2 of them 0");
  assert.equal(EXIT.submitted, 0);
  assert.equal(EXIT.skipped, 0, "a deliberate no-op is not a failure");
  for (const decision of nonZero) assert.notEqual(decision, 0);
});

test("the dashboard being DOWN is loud — trap row 1", async () => {
  const { root, result } = await runScenario({ name: "down", health: "throw", expect: "unreachable" });
  assert.equal(result.decision, "unreachable");
  assert.equal(result.exitCode, EXIT.unreachable);
  const last = readJournal(root).rows.at(-1);
  assert.match(String(last?.reason), /ECONNREFUSED|could not reach/i);
  assert.match(String(last?.dashboardUrl), /127\.0\.0\.1/);
  assert.equal(listQueue(root).length, 1, "and the ticket is untouched");
});

test("a dashboard that answers but has NO authenticated CLI is unreachable, with the reason", async () => {
  const { root, result } = await runScenario({
    name: "unauthenticated",
    health: { status: 200, body: { ok: false, claudeAuth: "missing", codexAuth: "missing" } },
    expect: "unreachable",
  });
  assert.equal(result.decision, "unreachable");
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /authenticated/i);
});

test("an unavailable model is caught BEFORE a ticket is claimed", async () => {
  // Claiming first would strand the ticket on a fault that has nothing to do
  // with it, and the queue would drain one ticket per night into failed/.
  const { root, result } = await runScenario({
    name: "model gone",
    models: { status: 200, body: [{ ...OK_MODEL, available: false, reason: "run `claude login`" }] },
    expect: "unreachable",
  });
  assert.equal(result.decision, "unreachable");
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /claude login/);
  assert.equal(listQueue(root).length, 1, "the ticket is still queued");
  assert.equal(strandedClaims(root).length, 0);
  assert.equal(orphanIntents(readJournal(root).rows).length, 0, "and no intent was recorded, so no slot was spent");
});

test("the POST carries designLock auto, the ticket text, and NO Referer", async () => {
  const { requests } = await runScenario({ name: "post shape", expect: "submitted" });
  const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/api/runs"));
  const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
  // THIS CHECKS THE REQUEST, NOT THE EFFECT, and cannot check the effect from
  // here: the route validates `designLock` and DISCARDS it, so the field is INERT
  // until the two columns are persisted — which is Phase 4 Task 6, and Task 6 is
  // BLOCKED on the mockup-path seam (see orchestrator.test.ts's SEAM tests). This
  // assertion would pass unchanged if the server renamed the field tomorrow. Cron
  // still lands on "auto" today, by the server's default and not by this field.
  assert.equal(body["designLock"], "auto", "§17.3 rule 2, stated rather than inferred");
  assert.equal(body["ticketText"], TICKET);
  assert.equal(body["modelId"], MODEL);
  assert.equal(body["deploy"], false);
  assert.equal(post?.headers?.["Referer"], undefined, "a Referer would classify cron as interactive");
});

test("a 201 settles the ticket under its run id and journals the pair", async () => {
  const { root, result } = await runScenario({ name: "201", expect: "submitted" });
  assert.equal(result.decision, "submitted");
  assert.equal(result.runId, "run-x");
  const { rows } = readJournal(root);
  assert.equal(rows.filter((row) => row.phase === "intent").length, 1);
  assert.equal(orphanIntents(rows).length, 0);
  const settled = readdirSync(join(root, CRON_DIRS.submitted));
  assert.deepEqual(settled, ["run-x-t1-a.md"], "the run id is in the filename, so either end finds the other");
  assert.equal(listQueue(root).length, 0);
});

test("a 400 records the SERVER's own message and does not retry the ticket", async () => {
  const { root, result } = await runScenario({
    name: "400",
    create: {
      status: 400,
      body: {
        error: "invalid_ticket",
        message: "ticketText is 200000 characters; the cap is 100000",
        remediation: "Split the work",
      },
    },
    expect: "rejected",
  });
  assert.equal(result.decision, "rejected");
  assert.equal(result.exitCode, EXIT.rejected);
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /the cap is 100000/);
  assert.equal(listQueue(root).length, 0);
  assert.equal(readdirSync(join(root, CRON_DIRS.failed)).length, 1);
  assert.equal(strandedClaims(root).length, 0);
});

test("A POST THAT NEVER COMPLETED leaves the ticket CLAIMED and says the outcome is UNKNOWN", async () => {
  // The one case where the honest answer is "I do not know". Re-queueing on a
  // guess is how one brief becomes two builds; the next tick halts on it.
  const { root, result } = await runScenario({ name: "post died", create: "throw", expect: "unreachable" });
  assert.equal(result.decision, "unreachable");
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /UNKNOWN whether a run was created/);
  assert.equal(strandedClaims(root).length, 1, "the claim stays, so the next tick halts");
  assert.equal(readdirSync(join(root, CRON_DIRS.failed)).length, 0, "and it is NOT filed as refused");
});

test("a claimed ticket that no tick owns halts the NEXT tick, and nothing is submitted", async () => {
  const { root, result, requests } = await runScenario({
    name: "stranded",
    claimed: ["dead-a.md"],
    expect: "stranded",
  });
  assert.equal(result.exitCode, EXIT.stranded);
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /dead-a\.md/);
  assert.equal(requests.length, 0, "the halt happens before any request, so nothing can be spent");
  assert.equal(listQueue(root).length, 1, "and the queued ticket is untouched");
});

test("the ceiling is counted from the JOURNAL, so a restart cannot reset it", async () => {
  const { root, result } = await runScenario({ name: "ceiling", seedIntents: 4, expect: "refused" });
  assert.equal(result.exitCode, EXIT.refused);
  assert.match(result.reason, /ceiling is spent/);
  assert.match(result.reason, /4/);
  assert.equal(listQueue(root).length, 1, "the ticket stays queued for the next window");
  assert.equal(readdirSync(join(root, CRON_DIRS.submitted)).length, 0);
});

test("a run in flight is a SKIP that exits 0, and the ticket waits", async () => {
  const { root, result } = await runScenario({
    name: "overlap",
    runs: {
      status: 200,
      body: [
        {
          runId: "run-live",
          ticketTitle: "t",
          modelId: MODEL,
          status: "running",
          startedAt: NOW,
          endedAt: null,
          heldOutPass: null,
          falseFinish: null,
        },
      ] as readonly RunSummary[],
    },
    expect: "skipped",
  });
  assert.equal(result.exitCode, 0, "a deliberate refusal to overlap is not a failure");
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /run-live is running/);
  assert.equal(listQueue(root).length, 1);
});

test("the lease is released even when the tick fails", async () => {
  const { root } = await runScenario({
    name: "release",
    create: { status: 500, body: {} },
    expect: "rejected",
  });
  assert.equal(
    acquireLease(root, { tickId: "next", pid: 1, at: new Date().toISOString() }, 15, () => true).ok,
    true,
    "a lease left behind by a failed tick stops cron until its TTL expires",
  );
});

test("a lease-held tick journals and does NOT touch the queue", async () => {
  const { root, result, requests } = await runScenario({
    name: "held",
    liveLease: "other-tick",
    expect: "lease-held",
  });
  assert.equal(result.exitCode, EXIT["lease-held"]);
  assert.match(result.reason, /other-tick/);
  assert.equal(requests.length, 0);
  assert.equal(listQueue(root).length, 1);
});

test("a misconfigured tick still journals, when the cron root itself is usable", async () => {
  // The config can fail for reasons that leave the directory perfectly writable,
  // and in that case there is no excuse for silence.
  const { root, result } = await runScenario({
    name: "misconfigured",
    env: { DASHBOARD_CRON_MODEL: "   " },
    expect: "misconfigured",
  });
  assert.equal(result.exitCode, EXIT.misconfigured);
  assert.match(String(readJournal(root).rows.at(-1)?.reason), /DASHBOARD_CRON_MODEL/);
});

test("TickDeps carries no way to start a run itself", () => {
  // The corruption case is two Orchestrators against one runs.db. This is a
  // type-level assertion, so it cannot be satisfied by a comment.
  type Forbidden = Extract<keyof TickDeps, "store" | "orchestrator" | "paths" | "bus" | "db">;
  const none: Forbidden extends never ? true : never = true;
  assert.equal(none, true);
});

test("a tick id is sortable and unique per process", () => {
  const a = newTickId(NOW, () => 0.111);
  const b = newTickId(NOW, () => 0.222);
  assert.notEqual(a, b);
  assert.match(a, /^2026-07-30T02-00-00-000Z-/);
});
