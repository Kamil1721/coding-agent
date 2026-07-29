/**
 * cron-tick.ts — one short-lived process, and eight ways it can end.
 *
 * WHAT A TICK IS NOT. It does not build, does not gate, does not supervise, and
 * above all DOES NOT CONSTRUCT AN `Orchestrator` OR OPEN `runs.db`. Its only
 * channel into the run pipeline is loopback HTTP against the dashboard that is
 * already running. That is not a convention: {@link TickDeps} is given a
 * `fetch`-shaped `http` and nothing else — no store, no orchestrator, no bus, no
 * writable `DashboardPaths` — so there is no code path through which a tick could
 * start a run itself. Two `Orchestrator`s against one `runs.db` is the corruption
 * case (both would `pump()`, both would claim the same queued row, two builders
 * would run in one workspace), and it is designed out rather than discouraged.
 *
 * THE TRAP THIS FILE IS SHAPED BY. Six of the seven ways a tick can end produce
 * the identical observable — "no new run appeared" — and only one of them,
 * "nothing was queued", is correct behaviour. So EVERY terminal path appends
 * exactly one journal outcome row naming the decision and why, and EVERY path
 * except the two deliberate no-ops exits non-zero so `launchd`'s
 * `StandardErrorPath` carries what the journal carries. One line also goes to
 * stdout, because that surface costs nothing.
 *
 * THE ONE FAILURE THIS DESIGN CANNOT RECORD DURABLY, said here rather than
 * pretended away: an unusable cron root. If `readCronConfig` refuses — including
 * because the root is unwritable or inside the bake-off tree — there is nowhere
 * to append a row. The tick tries anyway (a config can fail for reasons that
 * leave the directory perfectly writable) and always writes stderr, but a machine
 * whose cron root cannot be created reports only through the OS scheduler's own
 * log. The other failure with no observer inside a tick is the schedule never
 * firing, which no running tick can see; the report's OVERDUE line is its
 * detector and it computes staleness at READ time.
 *
 * ORDER IS THE SAFETY PROPERTY. Health and model availability are checked BEFORE
 * a ticket is claimed: claiming first would strand a ticket on a fault that has
 * nothing to do with it, and the queue would drain one ticket a night into
 * `failed/`.
 */

import { pathToFileURL } from "node:url";
import type { HealthResponse, ModelOption, RunSummary } from "../api-types.js";
import type { CronDecision } from "./cron-journal.js";
import { appendIntent, appendOutcome, intentsInWindow, readJournal } from "./cron-journal.js";
import { readCronConfig, cronRoot } from "./cron-config.js";
import type { CronConfig } from "./cron-config.js";
import { acquireLease, releaseLease } from "./cron-lease.js";
import { decideTick } from "./cron-policy.js";
import { claim, ensureCronDirs, listQueue, settleFailed, settleSubmitted, strandedClaims } from "./cron-queue.js";

/** A `fetch`-shaped response, narrowed to what a tick reads. Real `fetch` satisfies it. */
export interface TickResponse {
  readonly status: number;
  text: () => Promise<string>;
}

export interface TickRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface TickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => string;
  readonly tickId: string;
  /** The ONLY channel to the run pipeline. `fetch`-shaped, injected in every test. */
  readonly http: (url: string, init?: TickRequestInit) => Promise<TickResponse>;
  readonly isAlive?: (pid: number) => boolean;
  /** Refresh `report.md`. Injected so Task 9's renderer is not a hard dependency of the sequence. */
  readonly writeReport?: (config: CronConfig, now: string) => void;
}

export interface TickResult {
  readonly decision: CronDecision;
  readonly reason: string;
  readonly runId: string | null;
  readonly exitCode: number;
}

/**
 * DISTINCT PER DECISION, and the two zeros are the two deliberate no-ops.
 *
 * `submitted` and `skipped` are the only successes: a tick that correctly did
 * nothing is not a failure, and reporting it as one would train the owner to
 * ignore the error log that carries the other six.
 */
export const EXIT: Readonly<Record<CronDecision, number>> = Object.freeze({
  submitted: 0,
  skipped: 0,
  misconfigured: 2,
  "lease-held": 3,
  stranded: 4,
  unreachable: 5,
  rejected: 6,
  refused: 7,
});

async function getJson<T>(deps: TickDeps, url: string): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  let response: TickResponse;
  try {
    response = await deps.http(url);
  } catch (error) {
    return { ok: false, why: `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, why: `${url} answered ${String(response.status)} with an unreadable body: ${String(error)}` };
  }
  if (response.status !== 200) {
    return { ok: false, why: `${url} answered ${String(response.status)}: ${text.slice(0, 400)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, why: `${url} answered 200 with a body that is not JSON: ${text.slice(0, 200)}` };
  }
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const at = deps.now();

  // 1. CONFIG. The one path that may have nowhere to journal.
  const configResult = readCronConfig(deps.env);
  if (!configResult.ok) {
    const result: TickResult = {
      decision: "misconfigured",
      reason: configResult.why,
      runId: null,
      exitCode: EXIT.misconfigured,
    };
    try {
      appendOutcome(cronRoot(deps.env), {
        tickId: deps.tickId,
        at,
        decision: "misconfigured",
        reason: configResult.why,
        ticketFile: null,
        runId: null,
        exitCode: result.exitCode,
        dashboardUrl: "",
        modelId: null,
      });
    } catch {
      // Nowhere to record it. stderr is the only surface left, and the caller
      // writes it unconditionally.
    }
    return result;
  }
  const config = configResult.config;

  const journal = (decision: CronDecision, reason: string, ticketFile: string | null, runId: string | null): TickResult => {
    const exitCode = EXIT[decision];
    appendOutcome(config.root, {
      tickId: deps.tickId,
      at: deps.now(),
      decision,
      reason,
      ticketFile,
      runId,
      exitCode,
      dashboardUrl: config.baseUrl,
      modelId: config.modelId,
    });
    return { decision, reason, runId, exitCode };
  };

  ensureCronDirs(config.root);

  // 2. THE LEASE. Two ticks in one minute would both claim and both spend.
  const holder = { tickId: deps.tickId, pid: process.pid, at };
  const lease = acquireLease(config.root, holder, config.leaseTtlMin, deps.isAlive);
  if (!lease.ok) {
    // NO REPORT ON THIS PATH, a deliberate deviation from the plan's step 10: the
    // lease holder is writing `report.md` right now, and a second writer buys
    // nothing — the journal row this tick just appended is what makes the refusal
    // visible, and the reader computes staleness from the journal, not from
    // report.md's mtime.
    return journal("lease-held", lease.why, null, null);
  }

  try {
    if (lease.brokeStale !== null) {
      // NOT a decision — the tick continues — but it must never be silent.
      process.stdout.write(
        `broke the stale lease of tick ${lease.brokeStale.tickId} (pid ${String(lease.brokeStale.pid)}) ` +
          `from ${lease.brokeStale.at}\n`,
      );
    }

    // 3. A STRANDED CLAIM HALTS. Guessing whether a POST landed means risking a
    // duplicate build; the journal's intent row plus GET /api/runs answers it.
    const stranded = strandedClaims(config.root);
    if (stranded.length > 0) {
      return journal(
        "stranded",
        `${String(stranded.length)} claimed ticket(s) from a tick that did not finish: ${stranded.join(", ")}. ` +
          `Check the journal's intent row and GET /api/runs, then move each file back to queue/ or to failed/.`,
        stranded[0] ?? null,
        null,
      );
    }

    // 4. IS THE DASHBOARD THERE, AND CAN THE MODEL RUN. Neither call costs quota:
    // GET /api/models spawns the CLI's model list and sends no prompt.
    const health = await getJson<HealthResponse>(deps, `${config.baseUrl}/api/health`);
    if (!health.ok) return journal("unreachable", health.why, null, null);
    if (health.value.ok !== true) {
      return journal(
        "unreachable",
        `the dashboard answered but no CLI is authenticated (claude ${health.value.claudeAuth}, ` +
          `codex ${health.value.codexAuth}); a submission would be refused as model_unavailable`,
        null,
        null,
      );
    }

    const models = await getJson<readonly ModelOption[]>(deps, `${config.baseUrl}/api/models`);
    if (!models.ok) return journal("unreachable", models.why, null, null);
    const model = models.value.find((option) => option.id === config.modelId);
    if (model === undefined) {
      return journal(
        "unreachable",
        `${config.modelId} is not in the dashboard's catalog; GET /api/models lists the ids it accepts`,
        null,
        null,
      );
    }
    if (!model.available) {
      return journal(
        "unreachable",
        `${config.modelId} is not available: ${model.reason ?? "no reason recorded"}`,
        null,
        null,
      );
    }

    // 5. THE POLICY.
    const runs = await getJson<readonly RunSummary[]>(deps, `${config.baseUrl}/api/runs`);
    if (!runs.ok) return journal("unreachable", runs.why, null, null);
    const read = readJournal(config.root);
    const now = deps.now();
    const plan = decideTick({
      now,
      runs: runs.value,
      intentsInWindow: intentsInWindow(read.rows, now, config.windowHours).length,
      queue: listQueue(config.root),
      maxRunsPerWindow: config.maxRunsPerWindow,
      windowHours: config.windowHours,
    });
    if (plan.kind === "skip") return journal("skipped", plan.reason, null, null);
    if (plan.kind === "refuse") return journal("refused", plan.reason, null, null);

    // 6. THE INTENT, BEFORE THE POST. The ceiling counts these, so a tick killed
    // in the next three lines still spent its slot.
    appendIntent(config.root, {
      tickId: deps.tickId,
      at: deps.now(),
      reason: plan.reason,
      ticketFile: plan.ticketFile,
      dashboardUrl: config.baseUrl,
      modelId: config.modelId,
    });

    // 7. THE CLAIM.
    const claimed = claim(config.root, plan.ticketFile, deps.tickId);
    if (!claimed.ok) {
      return journal("skipped", `the ticket was not claimable: ${claimed.why}`, plan.ticketFile, null);
    }

    // 8. THE POST. `designLock: "auto"` is STATED rather than inferred from the
    // absence of a Referer — a header policy or a proxy can drop a header, and a
    // future edit to the server's interactive classifier would silently flip cron
    // to "ask". NOTE, because it would otherwise read as a policy guarantee: the
    // route validates this field and DISCARDS it (Phase 4 Task 6 is blocked on the
    // mockup-path seam), so today it lands on "auto" through the server's default
    // rather than through this field.
    const body = JSON.stringify({
      ticketText: claimed.ticketText,
      modelId: config.modelId,
      deploy: config.deploy,
      designLock: "auto",
    });
    let response: TickResponse;
    try {
      response = await deps.http(`${config.baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      // THE TICKET STAYS CLAIMED, DELIBERATELY. We do not know whether the server
      // saw this request, and re-queueing on a guess is how one brief becomes two
      // builds. The next tick halts on `stranded` and the owner decides.
      return journal(
        "unreachable",
        `the POST did not complete, so it is UNKNOWN whether a run was created: ` +
          `${error instanceof Error ? error.message : String(error)}. ${claimed.claimedPath} is left claimed ` +
          `on purpose; the next tick will halt on it.`,
        plan.ticketFile,
        null,
      );
    }

    const text = await response.text().catch(() => "");
    if (response.status !== 201) {
      settleFailed(config.root, claimed.claimedPath);
      return journal(
        "rejected",
        `the dashboard answered ${String(response.status)}: ${text.slice(0, 600)}`,
        plan.ticketFile,
        null,
      );
    }
    let runId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { runId?: unknown };
      if (typeof parsed.runId === "string" && parsed.runId.length > 0) runId = parsed.runId;
    } catch {
      runId = null;
    }
    settleSubmitted(config.root, claimed.claimedPath, runId ?? "unknown-run");
    return journal(
      "submitted",
      runId === null
        ? `201 Created, but the response body did not carry a runId: ${text.slice(0, 200)}. A run exists and ` +
          `GET /api/runs names it.`
        : `201 Created`,
      plan.ticketFile,
      runId,
    );
  } finally {
    if (deps.writeReport !== undefined) {
      // BEFORE THE RELEASE, so a reader who catches the lease file mid-tick sees a
      // report that matches it.
      try {
        deps.writeReport(config, deps.now());
      } catch (error) {
        process.stderr.write(`the cron report could not be refreshed: ${String(error)}\n`);
      }
    }
    releaseLease(config.root, deps.tickId);
  }
}

/** `2026-07-30T02-00-00-000Z-a1b2c3` — sortable, and unique per process. */
export function newTickId(now: string, random: () => number = Math.random): string {
  const stamp = now.replace(/[:.]/g, "-");
  return `${stamp}-${random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const result = await runTick({
    env: process.env,
    now: () => new Date().toISOString(),
    tickId: newTickId(now),
    http: async (url, init) => await fetch(url, init as RequestInit | undefined),
  });
  const line = `${result.decision}: ${result.reason}\n`;
  process.stdout.write(line);
  if (result.exitCode !== 0) process.stderr.write(line);
  process.exit(result.exitCode);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
